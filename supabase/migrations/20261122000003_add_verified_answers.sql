ALTER TABLE public.answers
  ADD COLUMN IF NOT EXISTS is_verified boolean NOT NULL DEFAULT false;

UPDATE public.answers
SET is_verified = false
WHERE is_verified IS NULL;

ALTER TABLE public.answers
  ALTER COLUMN is_verified SET DEFAULT false,
  ALTER COLUMN is_verified SET NOT NULL;

CREATE OR REPLACE FUNCTION public.reset_answer_verification_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.is_verified := false;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reset_answer_verification_on_insert ON public.answers;
CREATE TRIGGER reset_answer_verification_on_insert
  BEFORE INSERT ON public.answers
  FOR EACH ROW
  EXECUTE FUNCTION public.reset_answer_verification_on_insert();

REVOKE ALL ON FUNCTION public.reset_answer_verification_on_insert() FROM PUBLIC, anon, authenticated;

REVOKE UPDATE ON TABLE public.answers FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_answer_verified(
  p_division text,
  p_roll_number text,
  p_access_code text,
  p_answer_id text,
  p_is_verified boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NULLIF(trim(p_division), '') IS NULL
     OR NULLIF(trim(p_roll_number), '') IS NULL
     OR NULLIF(trim(p_access_code), '') IS NULL
     OR NULLIF(trim(p_answer_id), '') IS NULL
     OR p_is_verified IS NULL THEN
    RAISE EXCEPTION 'Administrator credentials and a valid verification status are required.'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."Credentials" AS credential
    WHERE credential.division = trim(p_division)
      AND credential.roll_number::text = trim(p_roll_number)
      AND upper(trim(credential.access_code)) = upper(trim(p_access_code))
      AND lower(trim(credential.role)) = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only administrators can verify or unverify replies.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.answers AS answer
  SET is_verified = p_is_verified
  WHERE answer.id::text = trim(p_answer_id);

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.set_answer_verified(text, text, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_answer_verified(text, text, text, text, boolean)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
