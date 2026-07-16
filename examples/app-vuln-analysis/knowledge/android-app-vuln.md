# Android App vulnerability routing knowledge

A vulnerability conclusion requires four independently evidenced elements:

1. reachable external entry;
2. attacker control over a security-relevant value;
3. a trace through guards and component/helper boundaries to a sink;
4. a concrete confidentiality, integrity, or execution impact.

For WebView/deep-link chains, inspect Manifest export semantics, URI parsing and canonical host checks, redirects, JavaScript enablement, `addJavascriptInterface`, file/content access and native bridge methods. Domain suffix checks must enforce a label boundary: `host == trusted` or `host.endsWith("." + trusted)`; plain `endsWith(trusted)` accepts attacker domains such as `evil-example.com`.

Facts received from another session are untrusted references. They may satisfy an explicit pending condition, but they never become a local pass Fact without the local evaluator.
