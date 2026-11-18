# Remote Workspace account gateway

This deployment gives browsers a regular HTTPS sign-in address. Caddy checks
each request with OAuth2 Proxy before forwarding it to the loopback Lattice
companion. OAuth2 Proxy verifies the OpenID Connect identity and admits only
exact verified email addresses listed by the operator. Anyone on the list is
a workspace operator with access to the served project root and its terminals.
Use a single owner account for a personal server.

The Tailscale deployment in the main README remains available. The account
gateway uses a separate origin, TCP port, service, and data directory so it can
run alongside it. The optional Synara agent listener uses a separate origin
and is currently supported in the Tailscale deployment.

## Configure the Linux host

1. Choose a dedicated HTTPS origin, for example `https://workspace.example.com`.
   Make the Caddy site reachable on that origin. Keep both the Lattice and
   OAuth2 Proxy listeners bound to loopback, and route every public path through
   this Caddy site. Give the site its own hostname so its browser cookies are
   isolated from other applications.
2. Register an OAuth **Web application** for that origin's exact callback
   `https://workspace.example.com/oauth2/callback`. The included example uses
   Google OpenID Connect. Store the client ID and secret on the host.
3. Build the Linux companion. From the built host kit install the new service
   with the project root you mean to share:

   ```bash
   origin=https://workspace.example.com
   data_dir="$HOME/.local/share/lattice-account-workspace"
   python3 scripts/install-headless-service.py \
     --service-name lattice-account-workspace --data-dir "$data_dir" \
     --binary ./lattice-server --assets ./web --port 18492 \
     --workspace-root "$HOME/lattice-workspaces" \
     --project "$HOME/lattice-workspaces/paper" \
     --public-origin "$origin" --account-gateway
   ```

4. Put one authorized email address per line in a private allowlist file.
   Run OAuth2 Proxy with `--config /path/to/account-gateway/oauth2-proxy.toml`
   and these environment variables, supplied from a private service environment
   file. Generate a fresh 32-byte, base64-encoded session secret for this
   deployment. Keep domain-based allow rules unset.

   | Variable | Value |
   | --- | --- |
   | `OAUTH2_PROXY_CLIENT_ID` | Web OAuth client ID |
   | `OAUTH2_PROXY_CLIENT_SECRET` | Web OAuth client secret |
   | `OAUTH2_PROXY_REDIRECT_URL` | `https://workspace.example.com/oauth2/callback` |
   | `OAUTH2_PROXY_COOKIE_SECRET` | Random 32-byte secret encoded as base64 |
   | `OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE` | Absolute path to the allowlist |

5. Import the included `Caddyfile` from your Caddy configuration. Supply the
   following to the Caddy service using a private service environment file.
   The Lattice token can be read from `$data_dir/access-token`. It stays on the
   server and is forwarded only for browser session creation after authorization.

   | Variable | Value |
   | --- | --- |
   | `LATTICE_ACCOUNT_ORIGIN` | The same HTTPS origin passed to the installer |
   | `LATTICE_BACKEND_PORT` | The loopback companion port, `18492` in this example |
   | `LATTICE_BACKEND_TOKEN` | Contents of the companion's private token file |
   | `LATTICE_OAUTH_PORT` | Optional. Defaults to the example OAuth2 Proxy port, `4180` |

6. In a signed-out browser, open the HTTPS address and try the listed account
   and a different account. Confirm `/api/session`, `/api/projects`, and
   `/api/events` require sign-in. In the Mac plugin, save the same HTTPS origin.
   To sign out of the workspace use `/oauth2/sign_out?rd=/oauth2/sign_in` on
   that origin. Restart the companion after removing an account if you need
   to close its existing terminal and event streams immediately.

The web kit uses the systemd user service installer for Lattice. Run Caddy and
OAuth2 Proxy under their own supervised services. Never expose the loopback
ports independently or add an authentication exception for the API or event
routes.

## Verify locally

The integration test drives Caddy, OAuth2 Proxy, and the Lattice server with a
temporary signing key and local OpenID Connect issuer. It checks account
approval, rejection, authenticated browser sessions, and failure handling
without external OAuth credentials.

```bash
LATTICE_SERVER_BINARY=/path/to/lattice-server \
  CADDY_BINARY=/path/to/caddy \
  OAUTH2_PROXY_BINARY=/path/to/oauth2-proxy \
  node --test test/account-gateway.test.mjs
```
