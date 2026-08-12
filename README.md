# pi-hashline

A base [Pi](https://github.com/earendil-works/pi) package that overrides `read` and `edit` with the hashline workflow from [oh-my-pi](https://github.com/can1357/oh-my-pi).

This initial port tracks oh-my-pi **v17.2.12** and preserves its core wire contract:

- reads return a `[path#TAG]` header and `LINE:content` rows;
- `TAG` is the low 16 bits of xxHash32 over normalized whole-file content;
- edits use the hashline `PUT`/`CUT` patch language;
- edits validate the whole-file snapshot tag and reject unsafe stale anchors;
- safe stale edits can recover by mapping unchanged, unambiguous anchors;
- named clipboard registers persist for the Pi session, bounded to 64 registers and 16 MiB;
- line endings and UTF-8 BOMs survive edits;
- `N*` block operations use oh-my-pi's native tree-sitter resolver.

`grep` and `write` integration are intentionally deferred.

## Install

For a local checkout, install its production dependencies first because Pi references local packages in place:

```bash
cd /absolute/path/to/pi-hashline
npm ci --omit=dev --omit=peer
pi install /absolute/path/to/pi-hashline
```

For development without changing Pi settings:

```bash
npm install --include=dev
pi -e /absolute/path/to/pi-hashline
```

The native stale-recovery and block parser supports glibc Linux (`x64`, `arm64`), macOS (`x64`, `arm64`), and Windows (`x64`). The extension fails clearly at startup on unsupported targets rather than silently weakening edit validation.

## Wire format

A read returns:

```text
[src/example.ts#1A2B]
1:export function greet() {
2:  return "hello";
3:}
```

Replace lines 2–3:

```text
[src/example.ts#1A2B]
PUT 2.=3:
+  return "hello, world";
+}
```

Insert after line 1:

```text
[src/example.ts#1A2B]
PUT >1:
+  console.log("greeting");
```

The `edit` tool accepts one `input` string containing one or more file sections. `MV DEST` refuses to overwrite an existing destination.

Files larger than 4 MiB remain readable through Pi's normal reader but do not receive a hashline tag, because the bounded session snapshot store will not retain them. The read result states this explicitly; `edit` is unavailable for that file until its size falls below the snapshot limit.

## Development

```bash
npm install
npm run verify
```

## Provenance

The hashline parser, patcher, recovery logic, prompt, grammar, and tests were ported from oh-my-pi v17.2.12 under its MIT license. Runtime-specific Bun APIs were replaced for base Pi's Node runtime. See source comments and Git history for the preserved architecture and behavior.
