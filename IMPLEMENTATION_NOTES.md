# Implementation notes / source gaps

The API follows the supplied FamFin contract. A few items are not fully specified by that contract and therefore require external configuration or a conservative server-side choice:

1. **Role-permission seed matrix is not supplied.** `HOUSEHOLD_ADMIN` is treated as all permissions so a newly created household works. All other roles are read from `role_permissions` exactly.
2. **Password hashes and refresh-token families are not represented in the business schema.** The server creates private internal collections `auth_credentials`, `auth_sessions`, and `auth_rate_limits`. They are not exposed through generic CRUD.
3. **Password reset confirmation/email delivery is not specified.** `/v1/auth/reset` keeps the required account-enumeration-safe 200 response; connect your identity/mail provider when the confirmation flow is defined.
4. **Apple/Google subscription verification credentials are not supplied.** The route is present and delegates verification to a server-to-server verifier configured with `SUBSCRIPTION_VERIFIER_URL`; it never trusts Flutter-provided plan claims.
5. **The contract asks household creation to copy default categories and also says category listing returns global system categories plus household categories.** This implementation follows both literally: household creation clones available global defaults and list returns both.
6. **`x-step-up: verified` is defined by the client contract, but no server endpoint/token for cryptographically proving the password re-confirmation is specified.** The export endpoint therefore performs the literal header check. Before production household exports, bind step-up to a server-verified recent reauthentication event.
7. **Export processing needs a worker.** This package runs a lightweight in-process polling worker, suitable for the current single Render service. At larger scale, move export processing to a dedicated worker service.
