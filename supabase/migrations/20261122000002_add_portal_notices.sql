CREATE TABLE IF NOT EXISTS public."PortalNotices" (
  notice_id smallint PRIMARY KEY DEFAULT 1 CHECK (notice_id = 1),
  notice_text text,
  target_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_notices_text_length
    CHECK (notice_text IS NULL OR char_length(notice_text) <= 1000),
  CONSTRAINT portal_notices_active_text
    CHECK (NOT is_active OR length(trim(coalesce(notice_text, ''))) > 0)
);

ALTER TABLE public."PortalNotices" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."PortalNotices" FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public."PortalNotices" TO anon, authenticated;

DROP POLICY IF EXISTS portal_notices_read_active ON public."PortalNotices";
CREATE POLICY portal_notices_read_active
  ON public."PortalNotices"
  FOR SELECT
  TO anon, authenticated
  USING (is_active = true);

CREATE OR REPLACE FUNCTION public.set_portal_notice(
  p_division text,
  p_roll_number text,
  p_access_code text,
  p_notice_text text,
  p_target_at timestamptz,
  p_is_active boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NULLIF(trim(p_division), '') IS NULL
     OR NULLIF(trim(p_roll_number), '') IS NULL
     OR NULLIF(trim(p_access_code), '') IS NULL THEN
    RAISE EXCEPTION 'Administrator credentials are required.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."Credentials" AS credential
    WHERE credential.division = trim(p_division)
      AND credential.roll_number::text = trim(p_roll_number)
      AND upper(trim(credential.access_code)) = upper(trim(p_access_code))
      AND lower(trim(credential.role)) = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only administrators can manage portal notices.'
      USING ERRCODE = '42501';
  END IF;

  IF p_is_active AND length(trim(coalesce(p_notice_text, ''))) = 0 THEN
    RAISE EXCEPTION 'An active notice must include text.'
      USING ERRCODE = '22023';
  END IF;

  IF p_is_active AND char_length(p_notice_text) > 1000 THEN
    RAISE EXCEPTION 'Notice text cannot exceed 1000 characters.'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public."PortalNotices" (
    notice_id,
    notice_text,
    target_at,
    is_active,
    updated_at
  )
  VALUES (
    1,
    CASE WHEN p_is_active THEN trim(p_notice_text) ELSE NULL END,
    CASE WHEN p_is_active THEN p_target_at ELSE NULL END,
    p_is_active,
    now()
  )
  ON CONFLICT (notice_id) DO UPDATE
  SET notice_text = EXCLUDED.notice_text,
      target_at = EXCLUDED.target_at,
      is_active = EXCLUDED.is_active,
      updated_at = EXCLUDED.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.set_portal_notice(text, text, text, text, timestamptz, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_portal_notice(text, text, text, text, timestamptz, boolean)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
