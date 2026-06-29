ALTER TABLE "repos"
  ADD CONSTRAINT "repos_provider_check"
  CHECK (provider IN ('github', 'bitbucket'));
