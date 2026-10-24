# Security policy

RouteDock handles Stellar payments and the one-way-channel contract has not
been audited. Please do not disclose vulnerabilities in public issues.

## Private disclosure

Use GitHub's **Report a vulnerability** button on the Security tab (private
vulnerability reporting). Include affected commit, reproduction steps, impact,
and whether funds or credentials may be at risk. We will acknowledge reports
within 3 business days and provide a status update within 10 business days.

Do not include private keys, seed phrases, or real user data in a report.

## Verifying npm release provenance

Releases from this repository's `release.yml` workflow request a GitHub OIDC
identity token and enable npm provenance for all three public packages:
`@routedock/routedock`, `@routedock/nulth-sdk`, and `@routedock/mcp-server`.
Their repository metadata identifies this repository and each workspace directory.
Provenance links a published artifact to its source commit and build workflow;
it does not certify that the source code is safe. Existing versions cannot gain
provenance retroactively.

After the first release containing this change, install the new versions in a
project and run `npm audit signatures` to verify registry signatures and available
provenance attestations. Check each version's **Provenance** section on npmjs.com,
or inspect its attestation metadata (replace `<new-version>` with each package's
released version):

```sh
npm view '@routedock/routedock@<new-version>' dist.attestations --json
npm view '@routedock/nulth-sdk@<new-version>' dist.attestations --json
npm view '@routedock/mcp-server@<new-version>' dist.attestations --json
```

Verify each package separately: a successful signature audit alone does not prove
that every installed package has a provenance attestation. Confirm the source
repository, commit and workflow match the intended release.

The existing `NPM_TOKEN` still authenticates publication; the OIDC permission here
is used for provenance. After confirming a successful provenance-bearing release,
a maintainer should configure npm trusted publishing for each package, switch the
workflow to a compatible OIDC publishing toolchain, and remove `NPM_TOKEN`. That
registry-side migration is separate from enabling provenance.
