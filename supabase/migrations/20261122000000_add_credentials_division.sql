ALTER TABLE public."Credentials"
ADD COLUMN IF NOT EXISTS division text;

CREATE UNIQUE INDEX IF NOT EXISTS credentials_division_roll_number_unique
ON public."Credentials" (division, roll_number)
WHERE division IS NOT NULL;
