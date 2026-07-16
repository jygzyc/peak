# Two-App / Two-Session vulnerability analysis

This authorized fixture contains two distinct Android apps and assigns exactly
one app to each session:

- `app-sender` analyzes `apps/sender`, which broadcasts a private auth token in
  an unprotected implicit `com.peakdemo.AUTH_TOKEN` Intent.
- `app-receiver` analyzes `apps/receiver`, whose exported receiver stores the
  broadcast token and exposes it to JavaScript through a WebView bridge.

The receiver session must keep its impact Fact pending until its evaluator has
assessed the sender session's verified FactBroadcast. The external broadcast is
never copied into the receiver Graph as a local pass Fact. The final local
finding combines only receiver-local pass Facts while citing the evaluated
cross-session reference.

This is static source/configuration analysis of repository fixtures. It does
not scan, install, execute, or exploit an external application.
