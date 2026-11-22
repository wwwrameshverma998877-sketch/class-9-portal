ALTER TABLE public."Credentials"
ADD COLUMN IF NOT EXISTS secondary_session_token text;

CREATE OR REPLACE FUNCTION public.claim_credentials_session(
  p_division text,
  p_roll_number text,
  p_access_code text,
  p_device_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  credential public."Credentials"%ROWTYPE;
BEGIN
  IF NULLIF(trim(p_division), '') IS NULL
     OR NULLIF(trim(p_roll_number), '') IS NULL
     OR NULLIF(trim(p_access_code), '') IS NULL
     OR NULLIF(trim(p_device_token), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT c.*
  INTO credential
  FROM public."Credentials" AS c
  WHERE c.division = trim(p_division)
    AND c.roll_number::text = trim(p_roll_number)
    AND c.access_code = upper(trim(p_access_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF credential.current_session_token = p_device_token
     OR credential.secondary_session_token = p_device_token THEN
    RETURN jsonb_build_object(
      'status', 'claimed',
      'name', credential.student_name,
      'role', credential.role,
      'division', credential.division,
      'roll_number', credential.roll_number,
      'access_code', credential.access_code
    );
  END IF;

  IF NULLIF(credential.current_session_token, '') IS NULL THEN
    UPDATE public."Credentials"
    SET current_session_token = p_device_token
    WHERE division = trim(p_division)
      AND roll_number::text = trim(p_roll_number);
  ELSIF NULLIF(credential.secondary_session_token, '') IS NULL THEN
    UPDATE public."Credentials"
    SET secondary_session_token = p_device_token
    WHERE division = trim(p_division)
      AND roll_number::text = trim(p_roll_number);
  ELSE
    RETURN jsonb_build_object('status', 'limit_reached');
  END IF;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'name', credential.student_name,
    'role', credential.role,
    'division', credential.division,
    'roll_number', credential.roll_number,
    'access_code', credential.access_code
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_credentials_session(
  p_division text,
  p_roll_number text,
  p_access_code text,
  p_device_token text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  credential_id public."Credentials"%ROWTYPE;
BEGIN
  SELECT c.*
  INTO credential_id
  FROM public."Credentials" AS c
  WHERE c.division = trim(p_division)
    AND c.roll_number::text = trim(p_roll_number)
    AND c.access_code = upper(trim(p_access_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public."Credentials"
  SET current_session_token = CASE
        WHEN current_session_token = p_device_token THEN NULL
        ELSE current_session_token
      END,
      secondary_session_token = CASE
        WHEN secondary_session_token = p_device_token THEN NULL
        ELSE secondary_session_token
      END
  WHERE division = trim(p_division)
    AND roll_number::text = trim(p_roll_number);

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_credentials_session(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_credentials_session(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_credentials_session(text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_credentials_session(text, text, text, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
