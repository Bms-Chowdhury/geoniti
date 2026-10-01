-- ==============================================================================
-- THE GEOPACTS - PRODUCTION DATABASE SCHEMA & ROLE-AWARE RLS SECURITY
-- ==============================================================================
-- Roles: 'super_admin' and 'admin' ONLY
-- Authorization: Strictly tied to Supabase Auth UID (auth.uid()::text)
-- Enforces: PUBLIC != ADMIN != SUPER_ADMIN at the PostgreSQL kernel level
-- ==============================================================================

-- 1. Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==============================================================================
-- 1. CATEGORIES TABLE
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.categories (
    id TEXT PRIMARY KEY DEFAULT ('cat-' || substr(gen_random_uuid()::text, 1, 8)),
    name TEXT NOT NULL,
    name_bn TEXT DEFAULT '',
    slug TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT 'bg-slate-700',
    description TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==============================================================================
-- 2. ARTICLES TABLE
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.articles (
    id TEXT PRIMARY KEY DEFAULT ('article-' || gen_random_uuid()::text),
    slug TEXT UNIQUE,
    title TEXT NOT NULL,
    title_bn TEXT DEFAULT '',
    excerpt TEXT DEFAULT '',
    excerpt_bn TEXT DEFAULT '',
    content TEXT DEFAULT '',
    content_bn TEXT DEFAULT '',
    category TEXT DEFAULT 'World Affairs',
    category_bn TEXT DEFAULT 'আন্তর্জাতিক',
    category_slug TEXT DEFAULT 'world',
    category_id BIGINT,
    author JSONB NOT NULL DEFAULT '{"name":"Editorial Staff","nameBn":"সম্পাদকীয় বিভাগ","avatar":"https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80","role":"Staff Writer"}'::jsonb,
    author_id TEXT,
    date TEXT DEFAULT 'Recent',
    date_bn TEXT DEFAULT 'সাম্প্রতিক',
    read_time TEXT DEFAULT '3 min read',
    views INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    featured_image TEXT NOT NULL DEFAULT '',
    image_url TEXT DEFAULT '',
    tags JSONB DEFAULT '[]'::jsonb,
    is_breaking BOOLEAN DEFAULT FALSE,
    is_featured BOOLEAN DEFAULT FALSE,
    is_trending BOOLEAN DEFAULT FALSE,
    is_editors_pick BOOLEAN DEFAULT FALSE,
    video_url TEXT,
    status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'review', 'scheduled', 'published', 'archived')),
    version INTEGER DEFAULT 1,
    published_at TIMESTAMPTZ DEFAULT NOW(),
    scheduled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    seo_title TEXT,
    seo_description TEXT,
    canonical_url TEXT,
    alt_text TEXT,
    caption TEXT,
    credit TEXT,
    focus_keyword TEXT,
    secondary_keywords JSONB DEFAULT '[]'::jsonb,
    robots_index BOOLEAN DEFAULT TRUE,
    robots_follow BOOLEAN DEFAULT TRUE,
    og_title TEXT,
    og_description TEXT,
    og_image TEXT
);

-- Idempotent column additions if table already existed
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS featured_image TEXT NOT NULL DEFAULT '';
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT '';
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS category_id BIGINT;
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS author_id TEXT;
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS focus_keyword TEXT;
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS secondary_keywords JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS robots_index BOOLEAN DEFAULT TRUE;
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS robots_follow BOOLEAN DEFAULT TRUE;
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS og_title TEXT;
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS og_description TEXT;
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS og_image TEXT;
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS caption TEXT;
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS credit TEXT;

-- ==============================================================================
-- 3. TAGS TABLE
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.tags (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==============================================================================
-- 4. MEDIA TABLE (Asset metadata; binary WebP files live in 'news-images' bucket)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.media (
    id TEXT PRIMARY KEY DEFAULT ('media-' || extract(epoch from now())::bigint || '-' || substr(gen_random_uuid()::text, 1, 6)),
    url TEXT NOT NULL,
    storage_path TEXT,
    filename TEXT NOT NULL,
    alt_text TEXT DEFAULT '',
    caption TEXT DEFAULT '',
    credit TEXT DEFAULT 'The GeoPacts',
    mime_type TEXT DEFAULT 'image/webp',
    size_bytes BIGINT DEFAULT 0,
    used_in_article_ids JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==============================================================================
-- 5. AD SETTINGS TABLE
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.ad_settings (
    id BIGINT PRIMARY KEY DEFAULT 1,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.ad_settings ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ==============================================================================
-- 6. SITE SETTINGS TABLE
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.site_settings (
    id TEXT PRIMARY KEY DEFAULT 'primary',
    brand_name TEXT DEFAULT 'The GeoPacts',
    tagline TEXT DEFAULT 'Modern Global News & Geopolitics Journal',
    canonical_domain TEXT DEFAULT 'https://thegeopacts.com',
    publisher_org_id TEXT DEFAULT 'https://thegeopacts.com/#organization',
    contact_email TEXT DEFAULT 'editorial@thegeopacts.com',
    config JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==============================================================================
-- 7. NEWSROOM USERS & RBAC TABLE (Strictly 'super_admin' and 'admin')
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.newsroom_users (
    id TEXT PRIMARY KEY, -- Must match auth.users.id (auth.uid()::text)
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('super_admin', 'admin')),
    title TEXT DEFAULT 'Newsroom Administrator',
    avatar TEXT DEFAULT '',
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login TIMESTAMPTZ
);

-- ==============================================================================
-- 8. AUDIT LOGS TABLE
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id TEXT PRIMARY KEY DEFAULT ('log-' || extract(epoch from now())::bigint || '-' || substr(gen_random_uuid()::text, 1, 6)),
    actor_user_id TEXT NOT NULL,
    actor_role TEXT NOT NULL CHECK (actor_role IN ('super_admin', 'admin')),
    actor_name TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    before_state JSONB,
    after_state JSONB,
    ip_address TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==============================================================================
-- 9. PERFORMANCE INDEXES
-- ==============================================================================
CREATE INDEX IF NOT EXISTS idx_articles_status_pub ON public.articles (status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_slug ON public.articles (slug);
CREATE INDEX IF NOT EXISTS idx_articles_category ON public.articles (category_slug, status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_featured ON public.articles (published_at DESC) WHERE is_featured = TRUE;
CREATE INDEX IF NOT EXISTS idx_articles_trending ON public.articles (published_at DESC) WHERE is_trending = TRUE;
CREATE INDEX IF NOT EXISTS idx_articles_breaking ON public.articles (published_at DESC) WHERE is_breaking = TRUE;
CREATE INDEX IF NOT EXISTS idx_articles_editors_pick ON public.articles (published_at DESC) WHERE is_editors_pick = TRUE;

CREATE INDEX IF NOT EXISTS idx_categories_slug ON public.categories (slug);
CREATE INDEX IF NOT EXISTS idx_media_created_at ON public.media (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs (created_at DESC);

-- ==============================================================================
-- 10. STRICT UID-BASED ROLE CHECKING FUNCTIONS (SECURITY DEFINER)
-- No email fallback: Authorization relies 100% on auth.uid() matching active record
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.newsroom_users
    WHERE id = auth.uid()::text
      AND role = 'super_admin'
      AND active = true
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin_or_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.newsroom_users
    WHERE id = auth.uid()::text
      AND role IN ('super_admin', 'admin')
      AND active = true
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_super_admin() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin_or_super_admin() TO anon, authenticated;

-- ==============================================================================
-- 11. ARTICLE UPDATE INTEGRITY TRIGGER (Enforces column immutability for Admins)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.check_article_admin_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- SuperAdmin has unrestricted update permissions
  IF public.is_super_admin() THEN
    RETURN NEW;
  END IF;

  -- Admin is updating: enforce immutability on core system fields
  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'Security violation: Admin cannot modify article primary key (id).';
  END IF;

  IF NEW.created_at <> OLD.created_at THEN
    NEW.created_at := OLD.created_at; -- Protect original creation timestamp
  END IF;

  IF OLD.author_id IS NOT NULL AND NEW.author_id IS DISTINCT FROM OLD.author_id THEN
    RAISE EXCEPTION 'Security violation: Admin cannot reassign article author_id.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_article_admin_update ON public.articles;
CREATE TRIGGER trg_check_article_admin_update
  BEFORE UPDATE ON public.articles
  FOR EACH ROW EXECUTE FUNCTION public.check_article_admin_update();

-- ==============================================================================
-- 12. ROW LEVEL SECURITY (RLS) POLICIES
-- Enforces: PUBLIC != ADMIN != SUPER_ADMIN
-- ==============================================================================
ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsroom_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------------
-- 1. ARTICLES RLS
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public can view published articles" ON public.articles;
CREATE POLICY "Public can view published articles" 
ON public.articles FOR SELECT 
USING (
  status = 'published' 
  OR public.is_admin_or_super_admin()
);

DROP POLICY IF EXISTS "Admin and SuperAdmin can insert articles" ON public.articles;
CREATE POLICY "Admin and SuperAdmin can insert articles" 
ON public.articles FOR INSERT 
TO authenticated 
WITH CHECK (public.is_admin_or_super_admin());

DROP POLICY IF EXISTS "Admin and SuperAdmin can update articles" ON public.articles;
CREATE POLICY "Admin and SuperAdmin can update articles" 
ON public.articles FOR UPDATE 
TO authenticated 
USING (public.is_admin_or_super_admin())
WITH CHECK (public.is_admin_or_super_admin());

DROP POLICY IF EXISTS "Only SuperAdmin can delete articles" ON public.articles;
CREATE POLICY "Only SuperAdmin can delete articles" 
ON public.articles FOR DELETE 
TO authenticated 
USING (public.is_super_admin());

-- ------------------------------------------------------------------------------
-- 2. CATEGORIES RLS (Admin is Read-Only, SuperAdmin has Full Management)
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can view categories" ON public.categories;
CREATE POLICY "Anyone can view categories" 
ON public.categories FOR SELECT 
USING (true);

DROP POLICY IF EXISTS "Only SuperAdmin can manage categories" ON public.categories;
CREATE POLICY "Only SuperAdmin can manage categories" 
ON public.categories FOR ALL 
TO authenticated 
USING (public.is_super_admin()) 
WITH CHECK (public.is_super_admin());

-- ------------------------------------------------------------------------------
-- 3. TAGS RLS (Admin is Read-Only, SuperAdmin has Full Management)
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can view tags" ON public.tags;
CREATE POLICY "Anyone can view tags" 
ON public.tags FOR SELECT 
USING (true);

DROP POLICY IF EXISTS "Only SuperAdmin can manage tags" ON public.tags;
CREATE POLICY "Only SuperAdmin can manage tags" 
ON public.tags FOR ALL 
TO authenticated 
USING (public.is_super_admin()) 
WITH CHECK (public.is_super_admin());

-- ------------------------------------------------------------------------------
-- 4. MEDIA RLS (Admin can upload/register, SuperAdmin can delete)
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can view media" ON public.media;
CREATE POLICY "Anyone can view media" 
ON public.media FOR SELECT 
USING (true);

DROP POLICY IF EXISTS "Admin and SuperAdmin can register media" ON public.media;
CREATE POLICY "Admin and SuperAdmin can register media" 
ON public.media FOR INSERT 
TO authenticated 
WITH CHECK (public.is_admin_or_super_admin());

DROP POLICY IF EXISTS "Admin and SuperAdmin can update media metadata" ON public.media;
CREATE POLICY "Admin and SuperAdmin can update media metadata" 
ON public.media FOR UPDATE 
TO authenticated 
USING (public.is_admin_or_super_admin())
WITH CHECK (public.is_admin_or_super_admin());

DROP POLICY IF EXISTS "Only SuperAdmin can delete media" ON public.media;
CREATE POLICY "Only SuperAdmin can delete media" 
ON public.media FOR DELETE 
TO authenticated 
USING (public.is_super_admin());

-- ------------------------------------------------------------------------------
-- 5. AD SETTINGS RLS (Public read, SuperAdmin-only manage)
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public can view ad settings" ON public.ad_settings;
CREATE POLICY "Public can view ad settings" 
ON public.ad_settings FOR SELECT 
USING (true);

DROP POLICY IF EXISTS "Only SuperAdmin can modify ad settings" ON public.ad_settings;
CREATE POLICY "Only SuperAdmin can modify ad settings" 
ON public.ad_settings FOR ALL 
TO authenticated 
USING (public.is_super_admin()) 
WITH CHECK (public.is_super_admin());

-- ------------------------------------------------------------------------------
-- 6. SITE SETTINGS RLS (Public read, SuperAdmin-only manage)
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public can view site settings" ON public.site_settings;
CREATE POLICY "Public can view site settings" 
ON public.site_settings FOR SELECT 
USING (true);

DROP POLICY IF EXISTS "Only SuperAdmin can modify site settings" ON public.site_settings;
CREATE POLICY "Only SuperAdmin can modify site settings" 
ON public.site_settings FOR ALL 
TO authenticated 
USING (public.is_super_admin()) 
WITH CHECK (public.is_super_admin());

-- ------------------------------------------------------------------------------
-- 7. NEWSROOM USERS RLS (SuperAdmin-only, zero public access)
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "Only SuperAdmin can view and manage newsroom users" ON public.newsroom_users;
CREATE POLICY "Only SuperAdmin can view and manage newsroom users" 
ON public.newsroom_users FOR ALL 
TO authenticated 
USING (public.is_super_admin()) 
WITH CHECK (public.is_super_admin());

-- ------------------------------------------------------------------------------
-- 8. AUDIT LOGS RLS (Admin can insert actions, SuperAdmin can view and purge)
-- Enforces actor_user_id = auth.uid()::text to prevent identity spoofing
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "SuperAdmin can view audit logs" ON public.audit_logs;
CREATE POLICY "SuperAdmin can view audit logs" 
ON public.audit_logs FOR SELECT 
TO authenticated 
USING (public.is_super_admin());

DROP POLICY IF EXISTS "Admin and SuperAdmin can insert audit logs" ON public.audit_logs;
CREATE POLICY "Admin and SuperAdmin can insert audit logs" 
ON public.audit_logs FOR INSERT 
TO authenticated 
WITH CHECK (
  public.is_admin_or_super_admin() 
  AND (actor_user_id = auth.uid()::text OR public.is_super_admin())
);

DROP POLICY IF EXISTS "Only SuperAdmin can delete audit logs" ON public.audit_logs;
CREATE POLICY "Only SuperAdmin can delete audit logs" 
ON public.audit_logs FOR DELETE 
TO authenticated 
USING (public.is_super_admin());

-- ==============================================================================
-- 13. STORAGE BUCKET: 'news-images' & POLICIES
-- ==============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'news-images',
    'news-images',
    true,
    52428800, -- 50MB
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif']
)
ON CONFLICT (id) DO UPDATE SET
    public = true,
    file_size_limit = 52428800,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif'];

DROP POLICY IF EXISTS "Public can view news images" ON storage.objects;
CREATE POLICY "Public can view news images"
ON storage.objects FOR SELECT
USING (bucket_id = 'news-images');

DROP POLICY IF EXISTS "Admin and SuperAdmin can upload news images" ON storage.objects;
CREATE POLICY "Admin and SuperAdmin can upload news images"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'news-images' AND public.is_admin_or_super_admin());

DROP POLICY IF EXISTS "Admin and SuperAdmin can update news images" ON storage.objects;
CREATE POLICY "Admin and SuperAdmin can update news images"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'news-images' AND public.is_admin_or_super_admin());

DROP POLICY IF EXISTS "Only SuperAdmin can delete news images" ON storage.objects;
CREATE POLICY "Only SuperAdmin can delete news images"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'news-images' AND public.is_super_admin());

-- ==============================================================================
-- 14. DESIGNATED NEWSROOM ACCOUNTS SEED & AUTH SYNC TRIGGER
-- Designated:
-- - SuperAdmin: m2bmsbabu@gmail.com
-- - Admin:      niaongprumarma2001@gmail.com
-- - Admin:      dolymarma521@gmail.com
-- ==============================================================================

-- 1. Sync any existing auth.users into newsroom_users with their exact UID
DO $$
BEGIN
  INSERT INTO public.newsroom_users (id, email, name, role, title, active, created_at, last_login)
  SELECT 
    a.id::text,
    LOWER(a.email),
    CASE 
      WHEN LOWER(a.email) = 'm2bmsbabu@gmail.com' THEN 'M2 Babu'
      WHEN LOWER(a.email) = 'niaongprumarma2001@gmail.com' THEN 'Niaong Pru Marma'
      WHEN LOWER(a.email) = 'dolymarma521@gmail.com' THEN 'Doly Marma'
      ELSE split_part(a.email, '@', 1)
    END,
    CASE 
      WHEN LOWER(a.email) = 'm2bmsbabu@gmail.com' THEN 'super_admin'
      ELSE 'admin'
    END,
    CASE 
      WHEN LOWER(a.email) = 'm2bmsbabu@gmail.com' THEN 'Editor-in-Chief & Super Admin'
      ELSE 'Newsroom Administrator'
    END,
    true,
    NOW(),
    NOW()
  FROM auth.users a
  WHERE LOWER(a.email) IN ('m2bmsbabu@gmail.com', 'niaongprumarma2001@gmail.com', 'dolymarma521@gmail.com')
  ON CONFLICT (email) DO UPDATE SET
    id = EXCLUDED.id,
    role = EXCLUDED.role,
    title = EXCLUDED.title,
    active = true,
    last_login = NOW();
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 2. Automatic Auth Trigger: Links future Supabase Auth sign-ups to newsroom_users using NEW.id::text
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    assigned_role TEXT := 'admin';
    user_title TEXT := 'Newsroom Administrator';
    user_name TEXT;
BEGIN
    IF LOWER(NEW.email) = 'm2bmsbabu@gmail.com' THEN
        assigned_role := 'super_admin';
        user_title := 'Editor-in-Chief & Super Administrator';
        user_name := 'M2 Babu';
    ELSIF LOWER(NEW.email) = 'niaongprumarma2001@gmail.com' THEN
        assigned_role := 'admin';
        user_title := 'Newsroom Administrator';
        user_name := 'Niaong Pru Marma';
    ELSIF LOWER(NEW.email) = 'dolymarma521@gmail.com' THEN
        assigned_role := 'admin';
        user_title := 'Newsroom Administrator';
        user_name := 'Doly Marma';
    ELSE
        -- Unrecognized emails do NOT receive active newsroom access
        RETURN NEW;
    END IF;

    user_name := COALESCE(NEW.raw_user_meta_data->>'name', NEW.raw_user_meta_data->>'full_name', user_name);

    INSERT INTO public.newsroom_users (id, email, name, role, title, active, created_at, last_login)
    VALUES (
        NEW.id::text,
        LOWER(NEW.email),
        user_name,
        assigned_role,
        user_title,
        true,
        NOW(),
        NOW()
    )
    ON CONFLICT (email) DO UPDATE SET
        id = EXCLUDED.id,
        role = EXCLUDED.role,
        title = EXCLUDED.title,
        active = true,
        last_login = NOW();

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();
