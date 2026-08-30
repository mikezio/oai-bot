# Security

This project runs local AI workers with filesystem and command-line tools. Treat
it as trusted-user development software, not a hardened multi-tenant sandbox.

The default server binds to localhost. If you expose it to a LAN or tailnet,
understand that application-level authentication is not currently implemented.

Please report security issues privately through GitHub Security Advisories
instead of opening a public issue. Do not include credentials, account data,
private transcripts, or other sensitive information in a report.
