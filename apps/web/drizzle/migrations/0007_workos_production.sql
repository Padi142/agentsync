-- WorkOS production gives every person a new user ID, so forget the IDs from the sandbox.
-- On their next sign-in, a person with a verified email claims their existing account again
-- (see provisionUser), keeping their Template, Machines and Machine tokens.
UPDATE `user` SET `workos_id` = NULL;
