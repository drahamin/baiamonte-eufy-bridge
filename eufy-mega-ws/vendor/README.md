# Vendored source provenance

- `eufy-security-ws/` is the unmodified source from tag `3.1.0`, commit
  `e4709320f4e01e976ee65d53e763b6a656f0137d`.
- `eufy-security-client/` starts from tag `4.1.1`, commit
  `12c0933c2b322abbc18f13b91b71fcd059e0e547`, plus the reviewed changes described in the repository
  [architecture notes](../../ARCHITECTURE.md). Its local package version is `4.1.1-mega.13`.

Both packages are compiled inside the Docker build. Generated JavaScript and `node_modules` are not
committed.
