# Attack Routing

Route by observed source, controlled value, trust boundary, guard, and sink. Select the smallest chain that can prove both attacker control and visible impact.

## Composite Chains

| Observed behavior | Primary chain to test | Required pivots |
| --- | --- | --- |
| An exported entry validates one Bundle key/object but later uses another | object/key mismatch -> Intent redirect -> private target/action | prove both the checked value and the different sink value |
| A caller-controlled Parcelable/Serializable/Bundle field becomes a role, account, package, command, path, URI, or target | untrusted object parsing -> authorization confusion -> protected sink | preserve class loader/type, field origin, and post-parse value |
| Provider path/query/file/call/batch crosses a weaker guard | Provider exposure -> protected row/file/action or permission downgrade | compare every operation's permission and path/query handling |
| Provider/FileProvider output is returned or granted | Provider access -> URI grant/result -> private file disclosure | prove grant recipient, flags, URI scope, and readable content |
| Deep link, scan result, URL, or HTML controls a WebView | Web entry -> script/content control -> bridge/cookie/file/Provider/component impact | prove final origin and enabled capability, not only `loadUrl` |
| `intent://`, a custom scheme, or `Intent.parseUri()` is launched | Web/URI entry -> Intent redirect/grant -> private target | inspect component/package/selector/flags/ClipData stripping and API level |
| A PendingIntent is caller-supplied, mutable, fill-in capable, replayable, or returned | PendingIntent -> victim-identity action/grant/component | prove mutability, fill-in fields, creator identity, and final target |
| Broadcast, Messenger, AIDL, or service command reaches protected work | external IPC -> missing/weak guard -> result/reply/notification/action impact | bind caller identity before any identity-clearing or async boundary |
| An external archive, update, plugin, or DEX path reaches extraction/loading | attacker file -> traversal/overwrite/integrity failure -> code/data impact | prove canonical destination, integrity decision, and load/use point |
| Share, AccountManager, clipboard, notification, accessibility, or other app channel carries controlled data | cross-app channel -> trusted operation or disclosure | prove which app owns the final identity/data and what the attacker observes |
| External navigation controls fragment/task/dialog/lifecycle state | UI pivot -> approval/credential/protected action -> attacker-visible result | prove more than UI reachability; identify the security decision or data movement |

## Single-Surface Signals

Use these only when no composed chain is observed:

| Signal | Investigate | Reject when |
| --- | --- | --- |
| Exported component | direct protected screen/action/data access | downstream action is public or independently guarded |
| Nested Intent, selector, component, package, `ClipData`, or flags forwarded | Intent redirect or grant propagation | dangerous fields are rebuilt from trusted constants or stripped |
| `setResult()` returns extras or a URI | result data or URI-grant leak | caller is trusted and returned data/grant is non-sensitive |
| Implicit Intent carries sensitive data, grant, callback, or protected workflow | resolution hijack | explicit package/component or safe chooser/verification closes attacker resolution |
| Provider query/insert/update/delete/openFile/call/batch/getType | row/file disclosure, injection, action exposure, oracle, or guard mismatch | the exact operation enforces the needed permission/path/selection guard |
| Exported/bindable Service, Messenger, or AIDL endpoint | caller identity/command/reply abuse | effective signature/UID/package guard precedes privileged work |
| WebView bridge, message channel, file/content access, cookie, SSL proceed, or native scheme | script-to-native/data or trusted-session abuse | content origin is fixed/trusted and all relevant capabilities are disabled/guarded |
| Mutable/fill-in PendingIntent | victim-identity component/action/grant substitution | immutable token and fixed target/data prevent relevant substitution |
| External filename/path/archive/update/plugin/DEX | traversal, overwrite, integrity failure, or code loading | canonical path and signature/hash validation bind the consumed artifact |

## Trace Constraints

- Treat `Intent.parseUri()` output as attacker-controlled until component, package, selector, grant flags, and `ClipData` are explicitly constrained. Account for Android version behavior.
- Treat `setResult()` as an outbound trust boundary. Verify the original caller and any URI grant flags on the returned Intent.
- For Binder/AIDL/Messenger, capture caller identity before `clearCallingIdentity`, thread hopping, callback dispatch, or deferred work. A later check against the app's own identity is not a caller guard.
- For Providers, evaluate each operation independently. A guard in `query()` does not prove `openFile()`, `call()`, `applyBatch()`, `bulkInsert()`, or `getType()` is protected.
- For WebViews, prove who controls the final document origin after redirects and whether that origin can reach JavaScript bridges, message channels, cookies, files, content URIs, or native Intent dispatch.
- For paths and archives, follow decoded/canonical paths and extraction destinations, not only the raw input string.
- For PendingIntents, distinguish creator identity, sender identity, mutability, allowed fill-in fields, replay, and the final resolved target.

## Hard Stops

Stop the route and record the blocker when:

- the external actor cannot trigger the entrypoint under stated prerequisites;
- the security-relevant sink value is no longer attacker-controlled;
- an effective permission, identity, signature, target, origin, path, integrity, or user-confirmation guard holds;
- the alleged sink is non-sensitive in the reached context;
- the only result is a recoverable malformed-input crash or functional defect;
- the claimed impact requires a second unsupported vulnerability or an unstated privileged environment.
