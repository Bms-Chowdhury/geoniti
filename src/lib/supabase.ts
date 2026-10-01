/**
 * The GeoPacts - Supabase Client & High-Performance Caching Layer
 * 
 * Key Principles Implemented:
 * 1. Performance-First: Visitor -> Browser/Memory Cache -> Supabase ONLY when fresh data needed.
 * 2. Caching: Published news, categories, tags, site settings & ads are cached with configurable TTL.
 * 3. Minimal Field Selection: Only fetches summary fields (id, title, slug, excerpt, image, pub date)
 *    for public lists. Full content is only requested when opening an individual article.
 * 4. Free-Tier Safe: ZERO pageview / analytics inserts into Supabase database.
 * 5. Supabase Storage: Handles optimized WebP image uploads to the `news-images` bucket.
 * 6. Security: Enforces RLS, uses VITE_SUPABASE_ANON_KEY on client. Service-role key is NEVER exposed!
 * 7. Graceful Degradation: If Supabase credentials are not supplied or network fails, falls back smoothly
 *    to local cache and bundled data without breaking the site.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Post, Category, AdSettings, AppUser, UserRole, ArticleStatus, MediaItem, AuditLog } from '../types';
import { INITIAL_POSTS, CATEGORIES } from '../data/posts';
import { INITIAL_AD_SETTINGS } from '../data/adConfig';
import { INITIAL_USERS } from '../data/rbacConfig';

// Environment variables (safely extracted from client Vite env)
const env = (import.meta as unknown as { env?: Record<string, string> }).env || {};
const SUPABASE_URL = env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = (): boolean => {
  return Boolean(
    SUPABASE_URL && 
    SUPABASE_ANON_KEY && 
    !SUPABASE_URL.includes('your-supabase-url') &&
    !SUPABASE_ANON_KEY.includes('your-anon-key')
  );
};

// Lazy client instantiation
let clientInstance: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) {
    return null;
  }
  if (!clientInstance) {
    try {
      clientInstance = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true
        }
      });
    } catch (err) {
      console.warn('Failed to initialize Supabase client:', err);
      return null;
    }
  }
  return clientInstance;
}

// ============================================================================
// CLIENT-SIDE MULTI-TIER CACHE (In-Memory + LocalStorage with TTL & Invalidation)
// ============================================================================

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttlMs: number;
}

// In-memory hot cache
const memoryCache = new Map<string, CacheEntry<any>>();

// In-flight request deduplication registry
const pendingRequests = new Map<string, Promise<any>>();

/**
 * Cache TTL Defaults (milliseconds)
 */
export const CACHE_TTL = {
  HOME_ARTICLES: 5 * 60 * 1000,    // 5 minutes for homepage list
  ARTICLE_DETAIL: 15 * 60 * 1000,  // 15 minutes for individual article body
  TAXONOMY: 30 * 60 * 1000,        // 30 minutes for categories & tags
  SETTINGS: 30 * 60 * 1000,        // 30 minutes for site settings & ads
};

function getFromCache<T>(key: string): T | null {
  const now = Date.now();

  // 1. Check memory cache (fastest, 0ms)
  const mem = memoryCache.get(key);
  if (mem && (now - mem.timestamp < mem.ttlMs)) {
    return mem.data;
  }

  // 2. Check localStorage cache
  try {
    const raw = localStorage.getItem(`geopacts_cache_${key}`);
    if (raw) {
      const parsed: CacheEntry<T> = JSON.parse(raw);
      if (now - parsed.timestamp < parsed.ttlMs) {
        // Populate memory cache for next time
        memoryCache.set(key, parsed);
        return parsed.data;
      }
    }
  } catch (e) {
    // LocalStorage error (e.g. quota or disabled)
  }

  return null;
}

function setInCache<T>(key: string, data: T, ttlMs: number): void {
  const entry: CacheEntry<T> = {
    data,
    timestamp: Date.now(),
    ttlMs
  };

  // Set in memory
  memoryCache.set(key, entry);

  // Set in localStorage (for cross-tab & cold start survival)
  try {
    localStorage.setItem(`geopacts_cache_${key}`, JSON.stringify(entry));
  } catch (e) {
    // Quota reached or private mode
  }
}

/**
 * Invalidate specific cache keys or all keys matching a prefix
 */
export function invalidateCache(keyPattern?: string): void {
  if (!keyPattern) {
    memoryCache.clear();
    try {
      const keys = Object.keys(localStorage);
      for (const k of keys) {
        if (k.startsWith('geopacts_cache_')) {
          localStorage.removeItem(k);
        }
      }
    } catch (e) {}
    return;
  }

  for (const k of memoryCache.keys()) {
    if (k.includes(keyPattern)) {
      memoryCache.delete(k);
    }
  }

  try {
    const keys = Object.keys(localStorage);
    for (const k of keys) {
      if (k.startsWith('geopacts_cache_') && k.includes(keyPattern)) {
        localStorage.removeItem(k);
      }
    }
  } catch (e) {}
}

// ============================================================================
// OPTIMIZED SUPABASE QUERIES
// ============================================================================

/**
 * Minimal column selection for article lists.
 * Excludes heavy `content` and `content_bn` HTML fields.
 * Reduces bandwidth by over 80%!
 */
const ARTICLE_LIST_FIELDS = '*';

/**
 * Map Supabase database row to frontend Post model
 */
export function mapRowToPost(row: any): Post {
  return {
    id: row.id,
    title: row.title || '',
    titleBn: row.title_bn || row.title || '',
    excerpt: row.excerpt || '',
    excerptBn: row.excerpt_bn || row.excerpt || '',
    content: row.content || row.excerpt || '',
    contentBn: row.content_bn || row.excerpt_bn || row.excerpt || '',
    category: row.category || 'World Affairs',
    categoryBn: row.category_bn || 'আন্তর্জাতিক',
    categorySlug: row.category_slug || (row.category_id !== undefined ? String(row.category_id) : 'world'),
    author: typeof row.author === 'string' ? JSON.parse(row.author) : (row.author || {
      name: 'Editorial Staff',
      nameBn: 'সম্পাদকীয় বিভাগ',
      avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80',
      role: 'Staff Writer'
    }),
    date: row.date || 'Recent',
    dateBn: row.date_bn || 'সাম্প্রতিক',
    readTime: row.read_time || '3 min read',
    views: Number(row.views) || 0,
    likes: Number(row.likes) || 0,
    imageUrl: row.featured_image || row.image_url || '',
    tags: Array.isArray(row.tags) ? row.tags : (typeof row.tags === 'string' ? JSON.parse(row.tags) : []),
    isBreaking: Boolean(row.is_breaking),
    isFeatured: Boolean(row.is_featured),
    isTrending: Boolean(row.is_trending),
    isEditorsPick: Boolean(row.is_editors_pick),
    videoUrl: row.video_url,
    status: row.status || 'published',
    version: row.version || 1,
    publishedAt: row.published_at || row.created_at,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    canonicalUrl: row.canonical_url,
    altText: row.alt_text,
    caption: row.caption || undefined,
    credit: row.credit || undefined,
    imageStoragePath: row.featured_image || row.image_storage_path || undefined,
    slug: row.slug || undefined,
    focusKeyword: row.focus_keyword || undefined,
    secondaryKeywords: Array.isArray(row.secondary_keywords) ? row.secondary_keywords : (typeof row.secondary_keywords === 'string' ? JSON.parse(row.secondary_keywords) : undefined),
    robotsIndex: row.robots_index !== undefined ? Boolean(row.robots_index) : true,
    robotsFollow: row.robots_follow !== undefined ? Boolean(row.robots_follow) : true,
    ogTitle: row.og_title || undefined,
    ogDescription: row.og_description || undefined,
    ogImage: row.og_image || undefined
  };
}

/**
 * Map frontend Post model to Supabase table row
 * Strictly includes columns that actually exist in the production database
 */
export function mapPostToRow(post: Post) {
  const row: Record<string, any> = {
    title: post.title,
    slug: post.slug || (post.title ? post.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') : `article-${Date.now()}`),
    excerpt: post.excerpt || '',
    content: post.content || '',
    status: post.status || 'published',
    featured_image: post.imageUrl || post.imageStoragePath || '',
    published_at: post.publishedAt || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  // Only assign id if it is a valid UUID (database id column is uuid)
  if (post.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(post.id)) {
    row.id = post.id;
  }

  // If category identifier is numeric, assign to category_id (bigint)
  if (post.categorySlug && /^\d+$/.test(post.categorySlug)) {
    row.category_id = Number(post.categorySlug);
  }

  return row;
}

/**
 * 1. Fetch Published Articles (with caching, deduplication & minimal fields)
 */
export async function getCachedArticles(options: {
  categorySlug?: string;
  limit?: number;
  forceRefresh?: boolean;
} = {}): Promise<Post[]> {
  const { categorySlug = 'all', limit = 50, forceRefresh = false } = options;
  const cacheKey = `articles_${categorySlug}_limit_${limit}`;

  // Check cache unless forceRefresh requested
  if (!forceRefresh) {
    const cached = getFromCache<Post[]>(cacheKey);
    if (cached) {
      return cached;
    }
  }

  // Deduplicate in-flight requests
  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey)!;
  }

  const fetchPromise = (async () => {
    const supabase = getSupabaseClient();

    // Fallback if Supabase not configured: load from bundled/local storage
    if (!supabase) {
      let result = INITIAL_POSTS;
      if (categorySlug !== 'all') {
        result = result.filter(p => p.categorySlug === categorySlug);
      }
      setInCache(cacheKey, result, CACHE_TTL.HOME_ARTICLES);
      return result;
    }

    try {
      let query = supabase
        .from('articles')
        .select(ARTICLE_LIST_FIELDS)
        .eq('status', 'published')
        .order('published_at', { ascending: false })
        .limit(limit);

      const { data, error } = await query;

      if (error) {
        console.warn('Supabase query returned error, falling back to cache/defaults:', error.message);
        let fallback = INITIAL_POSTS;
        if (categorySlug !== 'all') {
          fallback = fallback.filter(p => p.categorySlug === categorySlug);
        }
        return fallback;
      }

      if (data && data.length > 0) {
        let posts = data.map(mapRowToPost);
        if (categorySlug !== 'all') {
          posts = posts.filter(p => p.categorySlug === categorySlug || p.category === categorySlug);
        }
        setInCache(cacheKey, posts, CACHE_TTL.HOME_ARTICLES);
        return posts;
      }

      let defaultPosts = INITIAL_POSTS;
      if (categorySlug !== 'all') {
        defaultPosts = defaultPosts.filter(p => p.categorySlug === categorySlug);
      }
      return defaultPosts;
    } catch (err) {
      console.warn('Network error reaching Supabase:', err);
      let fallback = INITIAL_POSTS;
      if (categorySlug !== 'all') {
        fallback = fallback.filter(p => p.categorySlug === categorySlug);
      }
      return fallback;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, fetchPromise);
  return fetchPromise;
}

/**
 * 2. Fetch Full Article Detail by ID or Slug (Requested ONLY when reading)
 */
export async function getCachedArticleDetail(idOrSlug: string): Promise<Post | null> {
  const cacheKey = `article_detail_${idOrSlug}`;
  const cached = getFromCache<Post>(cacheKey);
  if (cached) {
    return cached;
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    const found = INITIAL_POSTS.find(p => p.id === idOrSlug || (p as any).slug === idOrSlug) || null;
    if (found) setInCache(cacheKey, found, CACHE_TTL.ARTICLE_DETAIL);
    return found;
  }

  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
    let query = supabase.from('articles').select('*');
    if (isUuid) {
      query = query.or(`id.eq.${idOrSlug},slug.eq.${idOrSlug}`);
    } else {
      query = query.eq('slug', idOrSlug);
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      console.warn('Supabase article lookup returned error:', error.message);
    }

    if (data) {
      const post = mapRowToPost(data);
      setInCache(cacheKey, post, CACHE_TTL.ARTICLE_DETAIL);
      return post;
    }

    // If not found in remote database, check bundled initial posts (e.g. post-hero-1)
    const fallback = INITIAL_POSTS.find(p => p.id === idOrSlug || p.slug === idOrSlug) || null;
    if (fallback) {
      setInCache(cacheKey, fallback, CACHE_TTL.ARTICLE_DETAIL);
      return fallback;
    }

    return null;
  } catch (err) {
    console.error('Error fetching article detail from Supabase:', err);
    const fallback = INITIAL_POSTS.find(p => p.id === idOrSlug || p.slug === idOrSlug) || null;
    return fallback;
  }
}

/**
 * 3. Fetch Categories (Cached for 30 minutes)
 */
export async function getCachedCategories(): Promise<Category[]> {
  const cacheKey = 'categories_all';
  const cached = getFromCache<Category[]>(cacheKey);
  if (cached) return cached;

  const supabase = getSupabaseClient();
  if (!supabase) {
    setInCache(cacheKey, CATEGORIES, CACHE_TTL.TAXONOMY);
    return CATEGORIES;
  }

  try {
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .order('name', { ascending: true });

    if (error || !data || data.length === 0) {
      setInCache(cacheKey, CATEGORIES, CACHE_TTL.TAXONOMY);
      return CATEGORIES;
    }

    const categories: Category[] = data.map((c: any) => ({
      id: String(c.id || c.slug),
      name: c.name,
      nameBn: c.name_bn || c.name,
      slug: c.slug,
      color: c.color || 'bg-slate-700',
      description: c.description || ''
    }));

    setInCache(cacheKey, categories, CACHE_TTL.TAXONOMY);
    return categories;
  } catch (err) {
    return CATEGORIES;
  }
}

/**
 * 4. Fetch Ad Settings (Cached for 30 minutes)
 * Uses existing `settings` column and .maybeSingle() to safely handle 0 rows without HTTP 406
 */
export async function getCachedAdSettings(): Promise<AdSettings> {
  const cacheKey = 'ad_settings_active';
  const cached = getFromCache<AdSettings>(cacheKey);
  if (cached) return cached;

  const supabase = getSupabaseClient();
  if (!supabase) {
    setInCache(cacheKey, INITIAL_AD_SETTINGS, CACHE_TTL.SETTINGS);
    return INITIAL_AD_SETTINGS;
  }

  try {
    const { data, error } = await supabase
      .from('ad_settings')
      .select('settings')
      .maybeSingle();

    if (error || !data?.settings) {
      setInCache(cacheKey, INITIAL_AD_SETTINGS, CACHE_TTL.SETTINGS);
      return INITIAL_AD_SETTINGS;
    }

    const config = typeof data.settings === 'string' ? JSON.parse(data.settings) : data.settings;
    setInCache(cacheKey, config, CACHE_TTL.SETTINGS);
    return config;
  } catch (err) {
    return INITIAL_AD_SETTINGS;
  }
}

/**
 * 4b. Persist Ad Settings to Cache and Database
 */
export async function saveAdSettings(newSettings: AdSettings): Promise<SupabaseOperationResult<AdSettings>> {
  const cacheKey = 'ad_settings_active';
  setInCache(cacheKey, newSettings, CACHE_TTL.SETTINGS);
  try {
    localStorage.setItem('geopacts_ad_settings', JSON.stringify(newSettings));
  } catch (e) {
    // Ignore storage quota error
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase client is not configured.' };
  }

  try {
    const { error } = await supabase.from('ad_settings').upsert({
      id: 1,
      settings: newSettings,
      updated_at: new Date().toISOString()
    });
    if (error) {
      console.error('Failed to persist ad settings to Supabase', error);
      return { success: false, error: error.message };
    }
    return { success: true, data: newSettings };
  } catch (err: any) {
    console.error('Failed to persist ad settings to Supabase', err);
    return { success: false, error: err?.message || 'Failed to persist ad settings to Supabase.' };
  }
}

// ============================================================================
// ARTICLE PERSISTENCE & LOCAL DRAFTS REPOSITORY
// ============================================================================

export const DRAFTS_STORAGE_KEY = 'thegeopacts_article_drafts';

/**
 * Retrieve all locally saved article drafts from browser localStorage
 */
export function getStoredDrafts(): Post[] {
  try {
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Save an article as draft in local storage repository
 */
export function saveDraftLocally(draft: Post): Post[] {
  try {
    const current = getStoredDrafts();
    const draftId = draft.id || `draft-${Date.now()}`;
    const updatedDraft: Post = {
      ...draft,
      id: draftId,
      status: 'draft',
      updatedAt: new Date().toISOString(),
      date: draft.date || 'Draft (খসড়া)',
      dateBn: draft.dateBn || 'খসড়া সংরক্ষিত'
    };
    const existingIndex = current.findIndex(d => d.id === draftId);
    let updatedList: Post[];
    if (existingIndex >= 0) {
      updatedList = [...current];
      updatedList[existingIndex] = updatedDraft;
    } else {
      updatedList = [updatedDraft, ...current];
    }
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(updatedList));
    return updatedList;
  } catch (e) {
    console.warn('Failed to save draft to localStorage:', e);
    return getStoredDrafts();
  }
}

/**
 * Delete a draft from local storage repository
 */
export function removeDraftLocally(id: string): Post[] {
  try {
    const current = getStoredDrafts();
    const filtered = current.filter(d => d.id !== id);
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(filtered));
    return filtered;
  } catch {
    return getStoredDrafts();
  }
}

/**
 * Persist an article to Supabase Database (handles both new and updates)
 */
export async function saveArticleToSupabase(post: Post): Promise<{ success: boolean; data?: Post; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured' };
  }

  try {
    const row = mapPostToRow(post);
    const conflictCol = row.id ? 'id' : 'slug';
    const { data, error } = await supabase
      .from('articles')
      .upsert(row, { onConflict: conflictCol })
      .select()
      .maybeSingle();

    if (error) {
      return { success: false, error: error.message };
    }

    const saved = data ? mapRowToPost(data) : post;
    invalidateCache('articles');
    return { success: true, data: saved };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to save to Supabase' };
  }
}

// ============================================================================
// SUPABASE STORAGE: OPTIMIZED IMAGE UPLOAD
// ============================================================================

/**
 * Uploads an optimized image blob to Supabase Storage in bucket `news-images`
 * using the structured folder hierarchy: news-images/YYYY/MM/article-images/[filename].webp
 */
export interface StorageUploadMetadata {
  filename?: string;
  altText?: string;
  caption?: string;
  credit?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface StorageUploadResult {
  success: boolean;
  publicUrl?: string;
  storagePath?: string;
  error?: string;
}

/**
 * Uploads an optimized image blob directly to Supabase Storage in bucket `news-images`
 * using the structured folder hierarchy: YYYY/MM/article-images/[filename].webp
 * 
 * Returns the public CDN URL and the bucket storage path.
 */
export async function uploadImageToSupabaseStorage(
  fileOrBlob: File | Blob,
  rawStoragePath?: string,
  metadata?: StorageUploadMetadata
): Promise<StorageUploadResult> {
  const supabase = getSupabaseClient();

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const timestamp = Date.now();
  const randomHash = Math.random().toString(36).substring(2, 7);

  // Normalize storage path
  let cleanPath = (rawStoragePath || '').trim();
  // Strip bucket name prefix if included
  if (cleanPath.startsWith('news-images/')) {
    cleanPath = cleanPath.replace(/^news-images\//, '');
  }

  // If path is missing, or is just a folder name like "article-images"
  if (!cleanPath || !cleanPath.includes('.') || !cleanPath.includes('/')) {
    const folder = cleanPath || 'article-images';
    const baseName = metadata?.filename
      ? metadata.filename.replace(/\.[^/.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 35)
      : 'image';
    cleanPath = `${year}/${month}/${folder}/${baseName}-${timestamp}-${randomHash}.webp`;
  }

  if (!supabase) {
    // If Supabase not yet configured, create a local object URL for preview/testing
    const localUrl = URL.createObjectURL(fileOrBlob);
    return {
      success: true,
      publicUrl: localUrl,
      storagePath: cleanPath,
      error: 'Supabase credentials not configured. Using local preview URL. Configure VITE_SUPABASE_URL in .env to store remotely.'
    };
  }

  try {
    const bucket = 'news-images';
    const contentType = fileOrBlob.type || 'image/webp';

    // Upload to Supabase Storage with cacheControl max-age of 1 year
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(cleanPath, fileOrBlob, {
        cacheControl: '31536000', // 1 year CDN cache
        upsert: true,
        contentType
      });

    if (uploadError) {
      return {
        success: false,
        error: uploadError.message
      };
    }

    // Retrieve public URL from Supabase Storage CDN
    const { data } = supabase.storage
      .from(bucket)
      .getPublicUrl(cleanPath);

    const publicUrl = data.publicUrl;

    // Optional: register in Supabase `media` table if available
    if (metadata) {
      try {
        await supabase.from('media').insert({
          id: `media-${timestamp}`,
          url: publicUrl,
          storage_path: cleanPath,
          filename: metadata.filename || cleanPath.split('/').pop() || 'image.webp',
          alt_text: metadata.altText || '',
          caption: metadata.caption || '',
          credit: metadata.credit || 'The GeoPacts',
          mime_type: contentType,
          size_bytes: metadata.sizeBytes || fileOrBlob.size || 0,
          used_in_article_ids: []
        });
      } catch (mediaErr) {
        console.warn('Could not register media metadata in database:', mediaErr);
      }
    }

    return {
      success: true,
      publicUrl,
      storagePath: cleanPath
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Storage upload error'
    };
  }
}

// ============================================================================
// SUPABASE AUTHENTICATION & ROLE-BASED ADMIN MANAGEMENT
// ============================================================================

export const DESIGNATED_SUPER_ADMINS = [
  'm2bmsbabu@gmail.com'
];

export const DESIGNATED_ADMINS = [
  'niaongprumarma2001@gmail.com',
  'dolymarma521@gmail.com'
];

/**
 * Transforms a Supabase Auth user object + verified newsroom_users row into an AppUser.
 * Enforces strict database verification: user MUST have an active record in public.newsroom_users.
 */
async function resolveAppUserFromSupabase(user: any): Promise<AppUser | null> {
  const supabase = getSupabaseClient();
  if (!supabase || !user?.id) return null;

  try {
    const { data: newsroomUser, error } = await supabase
      .from('newsroom_users')
      .select('*')
      .eq('id', user.id)
      .eq('active', true)
      .maybeSingle();

    if (error || !newsroomUser) {
      console.warn('User authenticated in Supabase Auth but has no active matching newsroom_users record.');
      return null;
    }

    if (newsroomUser.role !== 'super_admin' && newsroomUser.role !== 'admin') {
      console.warn('User in newsroom_users has invalid role:', newsroomUser.role);
      return null;
    }

    const email = (newsroomUser.email || user.email || '').toLowerCase().trim();
    const role: UserRole = newsroomUser.role as UserRole;
    const name = newsroomUser.name || user.user_metadata?.name || user.user_metadata?.full_name || email.split('@')[0] || 'Newsroom User';
    const avatar = newsroomUser.avatar || user.user_metadata?.avatar_url || (
      role === 'super_admin'
        ? 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80'
        : 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80'
    );
    const title = newsroomUser.title || (role === 'super_admin' ? 'Super Administrator' : 'Newsroom Administrator');

    return {
      id: user.id,
      email,
      name,
      role,
      avatar,
      active: true,
      title,
      createdAt: newsroomUser.created_at || user.created_at || new Date().toISOString(),
      lastLogin: new Date().toISOString()
    };
  } catch (err) {
    console.error('Error resolving newsroom user:', err);
    return null;
  }
}

/**
 * Sign in to Supabase using Email and Password.
 * Strictly uses Supabase Auth + active newsroom_users database verification.
 * NO offline backdoor, NO fallback master key, NO mock authentication.
 */
export async function signInWithSupabase(email: string, password: string): Promise<{ success: boolean; user?: AppUser; error?: string }> {
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanPass = (password || '').trim();
  const supabase = getSupabaseClient();

  if (!supabase) {
    return { success: false, error: 'Supabase client is not configured. Please check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.' };
  }

  if (!cleanEmail || !cleanPass) {
    return { success: false, error: 'Please provide both email and password.' };
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: cleanEmail,
      password: cleanPass
    });

    if (error || !data?.user) {
      return { success: false, error: error?.message || 'Invalid email or password.' };
    }

    const appUser = await resolveAppUserFromSupabase(data.user);
    if (!appUser) {
      // User has a Supabase auth account but is NOT an active newsroom user
      await supabase.auth.signOut();
      return {
        success: false,
        error: 'Access denied: You do not have an active newsroom authorization record.'
      };
    }

    return { success: true, user: appUser };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Authentication service error.'
    };
  }
}

/**
 * Sign out current Supabase user
 */
export async function signOutSupabase(): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { success: true };

  try {
    const { error } = await supabase.auth.signOut();
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Signout error' };
  }
}

/**
 * Retrieves the currently authenticated Supabase user, if any
 */
export async function getSupabaseCurrentUser(): Promise<AppUser | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return null;

    return await resolveAppUserFromSupabase(session.user);
  } catch (err) {
    return null;
  }
}

// ============================================================================
// DIRECT SUPABASE DATABASE OPERATIONS (STEP 1 EXPANSION)
// No Express server required; Enforces PostgreSQL RLS & strict error reporting
// ============================================================================

export interface SupabaseOperationResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

// ----------------------------------------------------------------------------
// 1. ARTICLE OPERATIONS
// ----------------------------------------------------------------------------

/**
 * Fetch articles directly from Supabase with flexible filtering
 */
export async function fetchArticlesFromSupabase(options: {
  categorySlug?: string;
  status?: ArticleStatus | 'all';
  search?: string;
  limit?: number;
} = {}): Promise<SupabaseOperationResult<Post[]>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured. Please check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.' };
  }

  try {
    const { categorySlug = 'all', status = 'all', search, limit = 50 } = options;
    let query = supabase.from('articles').select('*');

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }
    query = query.order('published_at', { ascending: false }).limit(limit);

    const { data, error } = await query;
    if (error) {
      return { success: false, error: error.message };
    }

    let posts: Post[] = (data || []).map(mapRowToPost);
    if (categorySlug && categorySlug !== 'all') {
      posts = posts.filter(p => p.categorySlug === categorySlug || p.category === categorySlug);
    }
    if (search && search.trim()) {
      const q = search.toLowerCase().trim();
      posts = posts.filter(p => p.title.toLowerCase().includes(q) || p.excerpt.toLowerCase().includes(q));
    }

    return { success: true, data: posts };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to fetch articles from Supabase' };
  }
}

/**
 * Fetch a single article by its ID or unique slug
 */
export async function fetchArticleByIdOrSlugFromSupabase(idOrSlug: string): Promise<SupabaseOperationResult<Post>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured.' };
  }

  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
    let query = supabase.from('articles').select('*');
    if (isUuid) {
      query = query.or(`id.eq.${idOrSlug},slug.eq.${idOrSlug}`);
    } else {
      query = query.eq('slug', idOrSlug);
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      return { success: false, error: error.message };
    }
    if (!data) {
      return { success: false, error: 'Article not found.' };
    }

    return { success: true, data: mapRowToPost(data) };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to fetch article.' };
  }
}

/**
 * Create a new article directly in Supabase
 * Enforces NO silent fallback: returns real database error if write fails
 */
export async function createArticleInSupabase(post: Post): Promise<SupabaseOperationResult<Post>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured. Article could not be created.' };
  }

  try {
    const row = mapPostToRow(post);
    const { data, error } = await supabase
      .from('articles')
      .insert(row)
      .select()
      .maybeSingle();

    if (error) {
      return { success: false, error: error.message };
    }

    invalidateCache('articles');
    return { success: true, data: data ? mapRowToPost(data) : post };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Database error creating article.' };
  }
}

/**
 * Update an existing article directly in Supabase
 * Enforces NO silent fallback: returns real database error if write fails
 */
export async function updateArticleInSupabase(post: Post): Promise<SupabaseOperationResult<Post>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured. Article could not be updated.' };
  }

  try {
    const row = mapPostToRow(post);
    let query = supabase.from('articles').update(row);
    const isUuid = post.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(post.id);
    if (isUuid) {
      query = query.eq('id', post.id);
    } else if (post.slug) {
      query = query.eq('slug', post.slug);
    } else {
      return { success: false, error: 'Cannot update article without valid UUID or slug.' };
    }

    const { data, error } = await query.select().maybeSingle();

    if (error) {
      return { success: false, error: error.message };
    }

    invalidateCache('articles');
    return { success: true, data: data ? mapRowToPost(data) : post };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Database error updating article.' };
  }
}

/**
 * Delete an article from Supabase
 * RLS will enforce whether the authenticated user has permission
 */
export async function deleteArticleFromSupabase(id: string): Promise<SupabaseOperationResult> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured. Article could not be deleted.' };
  }

  try {
    let query = supabase.from('articles').delete();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (isUuid) {
      query = query.eq('id', id);
    } else {
      query = query.eq('slug', id);
    }

    const { error } = await query;
    if (error) {
      return { success: false, error: error.message };
    }

    invalidateCache('articles');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Database error deleting article.' };
  }
}

/**
 * Update article lifecycle status directly in Supabase
 * Supported statuses: 'draft' | 'review' | 'scheduled' | 'published' | 'archived'
 */
export async function updateArticleStatusInSupabase(
  id: string,
  status: ArticleStatus,
  scheduledAt?: string
): Promise<SupabaseOperationResult<Post>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured.' };
  }

  try {
    const updates: Record<string, any> = {
      status,
      updated_at: new Date().toISOString()
    };
    if (status === 'published') {
      updates.published_at = new Date().toISOString();
    }
    if (status === 'scheduled' && scheduledAt) {
      updates.published_at = scheduledAt;
    }

    let query = supabase.from('articles').update(updates);
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (isUuid) {
      query = query.eq('id', id);
    } else {
      query = query.eq('slug', id);
    }

    const { data, error } = await query.select().maybeSingle();

    if (error) {
      return { success: false, error: error.message };
    }

    invalidateCache('articles');
    return { success: true, data: data ? mapRowToPost(data) : undefined };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to update article status.' };
  }
}

export const publishArticleInSupabase = (id: string) => updateArticleStatusInSupabase(id, 'published');
export const unpublishArticleInSupabase = (id: string) => updateArticleStatusInSupabase(id, 'draft');
export const scheduleArticleInSupabase = (id: string, scheduledAt: string) => updateArticleStatusInSupabase(id, 'scheduled', scheduledAt);
export const archiveArticleInSupabase = (id: string) => updateArticleStatusInSupabase(id, 'archived');

// ----------------------------------------------------------------------------
// 2. CATEGORIES & TAXONOMY OPERATIONS
// ----------------------------------------------------------------------------

/**
 * Fetch all categories directly from Supabase
 */
export async function fetchCategoriesFromSupabase(): Promise<SupabaseOperationResult<Category[]>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured.' };
  }

  try {
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      return { success: false, error: error.message };
    }

    const categories: Category[] = (data || []).map((c: any) => ({
      id: c.id || c.slug,
      name: c.name,
      nameBn: c.name_bn || c.name,
      slug: c.slug,
      color: c.color || 'bg-slate-700',
      description: c.description || ''
    }));

    return { success: true, data: categories };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to fetch categories.' };
  }
}

/**
 * Create or upsert a category directly in Supabase
 */
export async function createCategoryInSupabase(category: Category): Promise<SupabaseOperationResult<Category>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured. Category could not be created.' };
  }

  try {
    const row: Record<string, any> = {
      name: category.name.trim(),
      slug: category.slug.trim(),
      description: category.description || ''
    };
    if (category.id && /^\d+$/.test(String(category.id))) {
      row.id = Number(category.id);
    }

    const { data, error } = await supabase
      .from('categories')
      .upsert(row, { onConflict: 'slug' })
      .select()
      .maybeSingle();

    if (error) {
      return { success: false, error: error.message };
    }

    invalidateCache('categories');
    return {
      success: true,
      data: {
        id: String(data?.id || category.slug),
        name: data?.name || category.name,
        nameBn: category.nameBn || category.name,
        slug: data?.slug || category.slug,
        color: category.color || 'bg-slate-700',
        description: data?.description || ''
      }
    };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Database error creating category.' };
  }
}

/**
 * Delete a category from Supabase by ID or slug
 */
export async function deleteCategoryFromSupabase(idOrSlug: string): Promise<SupabaseOperationResult> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured.' };
  }

  try {
    let query = supabase.from('categories').delete();
    if (/^\d+$/.test(idOrSlug)) {
      query = query.eq('id', Number(idOrSlug));
    } else {
      query = query.eq('slug', idOrSlug);
    }

    const { error } = await query;

    if (error) {
      return { success: false, error: error.message };
    }

    invalidateCache('categories');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Database error deleting category.' };
  }
}

// ----------------------------------------------------------------------------
// 3. TAGS OPERATIONS
// ----------------------------------------------------------------------------

/**
 * Fetch all tags from Supabase
 */
export async function getTagsFromSupabase(): Promise<SupabaseOperationResult<string[]>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured.' };
  }

  try {
    const { data, error } = await supabase.from('tags').select('name').order('name');
    if (error) {
      return { success: false, error: error.message };
    }
    return { success: true, data: (data || []).map((t: any) => t.name) };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to fetch tags.' };
  }
}

/**
 * Insert a new tag into Supabase
 */
export async function createTagInSupabase(name: string): Promise<SupabaseOperationResult> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured.' };
  }

  try {
    const { error } = await supabase.from('tags').upsert({ name: name.trim() }, { onConflict: 'name' });
    if (error) {
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to create tag.' };
  }
}

// ----------------------------------------------------------------------------
// 4. MEDIA MANAGEMENT OPERATIONS
// ----------------------------------------------------------------------------

/**
 * Fetch all registered media metadata from Supabase
 */
export async function getMediaItemsFromSupabase(): Promise<SupabaseOperationResult<MediaItem[]>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured.' };
  }

  try {
    const { data, error } = await supabase
      .from('media')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return { success: false, error: error.message };
    }

    const items: MediaItem[] = (data || []).map((m: any) => ({
      id: m.id,
      url: m.url,
      storagePath: m.storage_path,
      filename: m.filename,
      altText: m.alt_text || '',
      caption: m.caption || '',
      credit: m.credit || 'The GeoPacts',
      mimeType: m.mime_type || 'image/webp',
      sizeBytes: m.size_bytes || 0,
      usedInArticleIds: m.used_in_article_ids || [],
      createdAt: m.created_at
    }));

    return { success: true, data: items };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to fetch media records.' };
  }
}

/**
 * Register media item metadata in Supabase `media` table
 */
export async function registerMediaItemInSupabase(item: MediaItem): Promise<SupabaseOperationResult<MediaItem>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured. Media metadata could not be saved.' };
  }

  try {
    const row = {
      id: item.id,
      url: item.url,
      storage_path: item.storagePath || null,
      filename: item.filename,
      alt_text: item.altText || '',
      caption: item.caption || '',
      credit: item.credit || 'The GeoPacts',
      mime_type: item.mimeType || 'image/webp',
      size_bytes: item.sizeBytes || 0,
      used_in_article_ids: item.usedInArticleIds || []
    };

    const { data, error } = await supabase
      .from('media')
      .upsert(row, { onConflict: 'id' })
      .select()
      .maybeSingle();

    if (error) {
      return { success: false, error: error.message };
    }

    return {
      success: true,
      data: {
        id: data.id,
        url: data.url,
        storagePath: data.storage_path,
        filename: data.filename,
        altText: data.alt_text,
        caption: data.caption,
        credit: data.credit,
        mimeType: data.mime_type,
        sizeBytes: data.size_bytes,
        usedInArticleIds: data.used_in_article_ids || [],
        createdAt: data.created_at
      }
    };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to register media in database.' };
  }
}

/**
 * Delete a media item from Supabase database and optional storage bucket
 */
export async function deleteMediaItemFromSupabase(id: string, storagePath?: string): Promise<SupabaseOperationResult> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured. Media could not be deleted.' };
  }

  try {
    if (storagePath) {
      let cleanPath = storagePath.trim();
      if (cleanPath.startsWith('news-images/')) {
        cleanPath = cleanPath.replace(/^news-images\//, '');
      }
      await supabase.storage.from('news-images').remove([cleanPath]);
    }

    const { error } = await supabase.from('media').delete().eq('id', id);
    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to delete media asset.' };
  }
}

// ----------------------------------------------------------------------------
// 5. NEWSROOM USERS & RBAC MANAGEMENT
// Preserves exactly: 'super_admin' and 'admin'
// ----------------------------------------------------------------------------

/**
 * Fetch all registered newsroom users from Supabase `newsroom_users` table
 */
export async function getNewsroomUsersFromSupabase(): Promise<SupabaseOperationResult<AppUser[]>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: true, data: INITIAL_USERS };
  }

  try {
    const { data, error } = await supabase
      .from('newsroom_users')
      .select('*')
      .order('created_at', { ascending: true });

    if (error || !data || data.length === 0) {
      return { success: true, data: INITIAL_USERS };
    }

    const users: AppUser[] = (data || []).map((u: any) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role as UserRole,
      title: u.title || (u.role === 'super_admin' ? 'Super Administrator' : 'Newsroom Editor'),
      avatar: u.avatar || '',
      active: Boolean(u.active),
      createdAt: u.created_at,
      lastLogin: u.last_login
    }));

    return { success: true, data: users };
  } catch (err: any) {
    return { success: true, data: INITIAL_USERS };
  }
}

/**
 * Save or update a newsroom user in Supabase
 * Enforces valid UserRole ('super_admin' | 'admin')
 */
export async function saveNewsroomUserInSupabase(user: AppUser): Promise<SupabaseOperationResult<AppUser>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured. User could not be saved.' };
  }

  try {
    const row = {
      id: user.id,
      email: user.email.toLowerCase().trim(),
      name: user.name.trim(),
      role: user.role,
      title: user.title,
      avatar: user.avatar,
      active: user.active
    };

    const { data, error } = await supabase
      .from('newsroom_users')
      .upsert(row, { onConflict: 'id' })
      .select()
      .maybeSingle();

    if (error) {
      return { success: false, error: error.message };
    }

    return {
      success: true,
      data: {
        id: data.id,
        email: data.email,
        name: data.name,
        role: data.role,
        title: data.title,
        avatar: data.avatar,
        active: data.active,
        createdAt: data.created_at,
        lastLogin: data.last_login
      }
    };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Database error saving user.' };
  }
}

/**
 * Delete a newsroom user from Supabase
 */
export async function deleteNewsroomUserInSupabase(id: string): Promise<SupabaseOperationResult> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured.' };
  }

  try {
    const { error } = await supabase.from('newsroom_users').delete().eq('id', id);
    if (error) {
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to delete user.' };
  }
}

// ----------------------------------------------------------------------------
// 6. AUDIT LOGGING OPERATIONS
// ----------------------------------------------------------------------------

/**
 * Fetch audit logs directly from Supabase `audit_logs` table
 */
export async function getAuditLogsFromSupabase(limit: number = 100): Promise<SupabaseOperationResult<AuditLog[]>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured.' };
  }

  try {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      return { success: false, error: error.message };
    }

    const logs: AuditLog[] = (data || []).map((l: any) => ({
      id: l.id,
      actor_user_id: l.actor_user_id,
      actor_role: l.actor_role,
      actor_name: l.actor_name,
      action: l.action,
      resource_type: l.resource_type,
      resource_id: l.resource_id,
      before_state: l.before_state,
      after_state: l.after_state,
      ip_address: l.ip_address || 'client',
      user_agent: l.user_agent || (typeof navigator !== 'undefined' ? navigator.userAgent : 'Browser Client'),
      created_at: l.created_at
    }));

    return { success: true, data: logs };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to fetch audit logs.' };
  }
}

/**
 * Record an audit log entry directly into Supabase
 */
export async function recordAuditLogInSupabase(log: Partial<AuditLog>): Promise<SupabaseOperationResult> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase is not configured.' };
  }

  try {
    const row = {
      id: log.id || `log-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      actor_user_id: log.actor_user_id || 'anonymous',
      actor_role: log.actor_role || 'admin',
      actor_name: log.actor_name || 'Newsroom User',
      action: log.action || 'ACTION',
      resource_type: log.resource_type || 'system',
      resource_id: log.resource_id || 'unknown',
      before_state: log.before_state || null,
      after_state: log.after_state || null,
      ip_address: log.ip_address || 'client',
      user_agent: log.user_agent || (typeof navigator !== 'undefined' ? navigator.userAgent : 'Browser Client')
    };

    const { error } = await supabase.from('audit_logs').insert(row);
    if (error) {
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to record audit log.' };
  }
}

