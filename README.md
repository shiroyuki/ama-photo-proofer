# Photo Proofer

A desktop workspace for reviewing photos and videos directly from a memory card. Built with Electron, TypeScript, and Vite. All scanning and preview processing happens locally. Opening a card leaves the original media untouched and saves a `photo-proofing.json` cache in the opened folder.

## Run

Use Node.js 22.18+ or 24+ and npm.

```sh
npm install
npm start
```

Open a mounted memory card from the sidebar, or choose **Open folder** and select the card or its DCIM folder. Subfolders are scanned automatically. The app opens in thumbnail view. **Explore a sample collection** works offline and uses illustrative metadata.

For development, `npm run dev` starts Vite and Electron. Changes to the Electron code require restarting that command. The renderer can also be previewed in a browser with `npx vite`; native folder access is available only in Electron.

## Appearance

Open **Settings** at the bottom of the sidebar. The **Theme** switcher offers **System**, **Light**, and **Dark**. System is the default and follows operating-system changes while the app is open. An explicit choice is remembered across launches and applies to native windows and dialogs as well as the photo workspace. The interface uses grayscale in both themes. Blue indicates selection or information, red rejection or alerts, yellow warnings, and green acceptance or success. In-app branding is grayscale; photographs keep their original colors.

Open **About Photo Proofer** in the sidebar or app menu for the version, copyright, Apache 2.0 license, and an offline list of included open-source software and license notices. Credits are generated from installed dependencies during each build.

## Review

- Captures are sorted by their taken timestamp. Events are grouped under ISO date headings, then ordered by time within each date, in both the sidebar and thumbnail browser. A gap **greater than** the configured separation gap starts a new event (30 minutes by default). A gap exactly equal to the setting stays together. Adjacent captures continue across midnight in the same event under the starting date, with the ending date displayed.
- A JPEG and RAW sharing a filename stem in the same folder appear as one capture. JPEG opens by default. Choose RAW in the details panel or press **T** to switch the selected capture. Different directories and videos stay separate.
- Click a thumbnail to select it and see its metadata; click the sole selected thumbnail again to deselect it. A plain click replaces a group selection. Cmd/Ctrl-click toggles individual captures, Shift-click selects an anchored range in the current sort order, and Cmd/Ctrl+Shift-click adds a range. Drag a selection box across thumbnails; Cmd/Ctrl/Shift-drag adds to the selection, and dragging near the top or bottom scrolls the grid.
- Double-click or press **Enter** to open a single selected capture in the viewer. The viewer’s photo strip shows only captures from the current event that match the active filters, in the current sort order. It displays accept/reject badges and updates when navigation reaches another event. Arrow keys browse photos and videos. Changing the event or media filter clears the selection; search retains only visible selected captures.
- Press **A** to accept the selection or **D** to reject it. Repeating either action keeps that status. Rejected images are faded to 50% opacity in thumbnails, the viewer, the event strip, and the details preview; status badges stay fully visible. Press **S** or use **Clear status** to return the selection to unreviewed. Review marks are saved in the opened folder’s `photo-proofing.json` and restored when the same files are reopened.
- Filter by **All statuses**, **Accepted**, **Rejected**, or **Unreviewed**, combined with the media filters and filename/camera/lens search. The single **Find a capture** search field searches filenames, cameras, lenses, and labels, and offers label autocomplete from the active source, including cached labels when Ollama is off. **Review status** sits beside it. Choose labels by mouse or Arrow Up/Down and Enter; multiple labels match captures containing all selected labels. Remove individual label chips or use **Clear filters** to reset. Review and label filters update as decisions or background labels change. Use chronological sort and the thumbnail size slider to browse. The app can be used while a large card is still being scanned. Indexing has a progress bar with its file count on the same line; file discovery uses an indeterminate bar until the total is known. The indexing bar disappears when indexing completes. A separate review progress bar covers the current filtered view: green for accepted, red for rejected, and blue for unmarked captures up to and including the current position in the current sort order. Each capture counts once, with accepted/rejected statuses taking priority. Hover over any position in the bar to preview its capture; click to select and scroll to it in thumbnails or open it in the current viewer. The bar follows capture order, with keyboard Left/Right and Home/End navigation when focused. Moving backward reduces the blue portion; this is based on the current index rather than a history of opened photos.
- Missing capture timestamps fall back to file modification time and are clearly marked in the details panel. Missing metadata displays as unavailable.

| Shortcut | Action |
| --- | --- |
| Right | Next capture |
| Left | Previous capture |
| Enter | Open selected capture |
| Escape | Return to thumbnails / close shortcuts |
| T | Switch selected JPEG / RAW pair |
| I | Toggle details |
| Space | Play / pause video in the viewer |
| Cmd / Alt + Left / Right | Seek video backward / forward 5 seconds |
| A / D | Accept / reject selected captures |
| S | Clear acceptance or rejection |
| Cmd / Ctrl + A | Select all visible captures |
| ? | Show keyboard shortcuts |

## Event settings, refresh, and bookmarks

**Settings → Events** lets you set the event separation gap in whole minutes (1–10080, default 30). **Apply event gap** immediately regroups the current session and saves the preference for future sessions. The gallery, sidebar, event strip, AI summaries, and exports all use the same gap. Finish or stop active indexing, AI work, and exports before changing it. Review decisions and photo labels are retained; changed event groupings invalidate their old summaries, and any needed AI processing uses the normal confirmation flow.

Use **Reindex & rerun AI** under Sources to reread metadata and discard cached photo labels and event summaries for the opened folder. Review decisions for unchanged files stay intact. If Ollama is enabled, the button explicitly authorizes fresh background labels and summaries without a second confirmation. With Ollama off, only indexing runs. Original media stays untouched.

Click the **bookmark icon** beside the opened source to save or remove its location. Saved folders appear under **Bookmarks** in the sidebar and persist across app launches. Click one to reopen it; reconnect an unavailable memory card and retry. Disconnected bookmarks are kept until you remove them with their × button. Demo collections cannot be bookmarked or reindexed.

## Folder cache

Each opened folder keeps its indexed metadata, generated labels, and review decisions in **`photo-proofing.json`**. Entries use relative paths and are reused only while file size and modification time match. Missing files are ignored and removed from the cache during indexing. An older or incompatible schema is reset with a visible warning. A newer schema is preserved with a warning so an older app cannot overwrite it.

If the folder is read-only or disconnected, a warning explains that changes cannot be saved; reviewing can continue in memory. Original photos and videos remain untouched. Theme, Ollama preferences, and the export destination remain app-wide settings.

## Export

Choose **Export** in the header, then **Selected captures**, **Accepted captures**, or **Event**. Event export lets you choose a complete indexed event, including captures hidden by the current filters. Accepted export includes all accepted captures from the currently opened source, including those outside the current event or search. Review marks and exports apply to a paired JPEG/RAW capture as a unit; both original files are copied. Original videos are copied as well.

The destination defaults to your system **Pictures** folder. **Choose folder** opens the native folder picker, and the location is remembered across app launches. **Selected captures** export directly into the chosen destination. **Accepted captures** are organized into one folder per event, using the cached event summary when Ollama is enabled or a `YYYY-MM-DD_HH-mm-ss` timestamp otherwise. **Event** export continues to use a folder for the chosen event. Overnight events stay together. Original files are copied without recompression. Each event folder contains `photo-proofing-export.json` with its start/end timestamps, indexed metadata, full ExifTool-readable EXIF, labels, review decisions, and the actual exported filenames. Source file paths are relative; ExifTool’s source-file and directory bookkeeping fields are excluded. JSON contains only successfully copied files and records incomplete exports and metadata-read failures. Selected exports save the JSON beside the media in the destination, recording each file’s event; existing JSON manifests receive a numbered filename. Repeated accepted or event exports create a new numbered event folder; filename collisions within an event receive a consistent suffix for both JPEG and RAW. A progress indicator shows the current file. **Stop after current file** keeps copies already completed. Unreadable files are reported individually while readable files continue to export. The optional demo collection cannot be exported.

The new logo is available as a transparent [SVG](public/logo.svg) and a 1024px [PNG](public/icon.png). The outer circle has a white fill and black stroke; the inner red ring has no fill. To regenerate the PNG from the source vector, run `node scripts/icon.cjs`.

### Event summaries

When Ollama is enabled, the confirmed background labelling job also creates one short summary per event with the local `gemma4:e2b` model. It considers **all photos in that event**, including unaccepted and rejected photos. Up to three representative resized photo previews provide the primary evidence, even when photos already have labels. Existing labels supply supporting context. Events without photos (including video-only events) are skipped without requesting a summary or counting a failure. Unreadable preview samples produce visible warnings; readable samples are still used. If none of the sampled previews can be read, no description is generated. Summaries appear in the sidebar and event headings, with their own background progress bar.

Previously cached summaries from the labels-first generator are refreshed using photo previews after confirmation. Summaries are cached in the opened folder's `photo-proofing.json` and keyed to the event's file fingerprints. Reopening the folder reuses them; changing acceptance, filters, or export selections does not regenerate or rename the event. Changing the photos invalidates the corresponding summary. Stopping background work or disabling Ollama stops unstarted summaries while letting the current summary finish and save.

**Accepted captures** folder exports use that event summary as the folder name, for example `mountain-lake-sunrise`. A missing summary can be generated at export time from the **full event**, then cached and reused. Names contain only lowercase ASCII letters, numbers, and hyphens; collisions use `-2`, `-3`, etc. The summary and its source are also recorded in the export JSON. If inference fails, export continues with a safe fallback and a visible warning. Explicitly disabling Ollama retains timestamp-only naming. Selected, Event, and Photos export naming is unchanged.

### Export to Photos (macOS)

On macOS, the export dialog also offers **Photos** as a destination for selected, accepted, or event captures. Each event is imported into a named album, reusing an album with the same event name when present. Labels are merged into the imported media items’ Photos keywords, preserving existing keywords. Both original files of JPEG/RAW pairs are submitted together, and original videos can be included. Photos uses its current library, supported formats, and duplicate checking. The original card files stay untouched. Folder remains the default destination; choosing Photos does not change the remembered export folder.

The first import may ask for permission to control Photos. If denied, allow Photo Proofer under **System Settings → Privacy & Security → Automation** and retry. Imports run in batches and **Stop after current batch** leaves work already processed by Photos in place. Photos may represent a RAW/JPEG pair as one media item and skip duplicates. If a labelled capture is skipped and Photos returns no imported item, a visible export error reports that its keywords could not be applied safely; the app does not guess which existing library item to modify. Keyword failures are also reported even when the original was imported. The number of library items can differ from the number of submitted files. A failed or timed-out import may have processed some files; check Photos before retrying.

## Optional Ollama photo tags

Open **Settings → Photo tagging** to enable or disable local tagging. On **macOS**, it defaults to **on when the local model is ready**; no dedicated-GPU check applies. An explicit on/off choice is remembered across launches. On Windows/Linux it remains **off by default**. Install and start [Ollama](https://ollama.com/), install the exact [gemma4:e2b](https://ollama.com/library/gemma4:e2b) model with `ollama pull gemma4:e2b`, and select **Check again**. The app never downloads models or starts the Ollama service.

The toggle is disabled with a warning when a dedicated GPU with its own video memory cannot be confirmed on **Windows/Linux**, when Ollama is unreachable at `127.0.0.1:11434`, or when the exact model is missing or does not report vision support. GPU identification is conservative: known discrete NVIDIA, AMD Radeon, or Intel Arc adapters need reported non-shared VRAM; integrated, virtual, and unknown adapters remain disabled. Cloud-backed model aliases are rejected. Eligibility is checked before enabling and before each tagging batch, and can be refreshed in Settings.

When enabled, each indexed proofing session asks for confirmation before labelling starts. Enabling Ollama after a session has already been indexed also asks for confirmation. Cancel leaves the setting and queue unchanged. After confirmation, labelling runs in the background so you can continue browsing, reviewing, and exporting. A separate labelling progress bar shows completed and total photo counts alongside the bar, independently of indexing progress. JPEG is preferred for a JPEG/RAW pair. RAW-only captures use their embedded preview. A resized JPEG preview, without copied EXIF metadata, is sent to the fixed local Ollama endpoint using the [image generation API](https://docs.ollama.com/api/generate); originals and videos are never submitted. One photo is processed at a time. Tags appear in photo details and can be searched alongside filenames, cameras, and lenses. They are cached in the opened folder’s `photo-proofing.json` using relative file path, size, and modification time, so previously tagged, unchanged files are not inferred again. The app does not write tags into originals.

Disabling labelling or selecting **Stop queued labelling** asks for confirmation. After confirmation, photos that have not started are removed from the queue; the current photo finishes and its labels are saved. Existing labels remain available. Cancelling the confirmation leaves labelling running. **Tag untagged photos** asks before starting or resuming missing labels. Closing the app or changing sources still cancels active requests so they cannot outlive their session. A model or preview error appears in the selected photo's tag panel. Availability checks use Ollama's local API and [systeminformation GPU data](https://systeminformation.io/graphics.html). The renderer cannot choose a different host, model, or unapproved file path.

## Format support

RAW extensions include ARW, CR2, CR3, NEF, NRW, RAF, ORF, RW2, PEF, DNG, SRW, RWL, 3FR, IIQ, MOS, MEF, ERF, KDC, and DCR. ExifTool reads metadata and extracts the camera's embedded JPEG preview, preferring `JpgFromRaw`, then `PreviewImage`, `OtherImage`, and `ThumbnailImage`. **This is a review app, not a RAW developer:** it does not demosaic sensor data. Preview resolution depends on what the camera embeds. Files with no usable embedded preview show an error; a paired JPEG remains available.

JPEG, PNG, WebP, AVIF, TIFF, and HEIF/HEIC extensions are recognized. Preview decoding depends on the bundled Sharp/libvips codecs; HEIC support varies. JPEG orientation is honored. RAW previews use their embedded orientation, falling back to the RAW file’s orientation tag.

Videos play directly from their original files using Electron's Chromium media player, with streaming and seeking. MP4/MOV/M4V/WebM and other video extensions are recognized, but playback depends on the container and codec supported by the runtime. There is no transcoding; unsupported codecs show a playback error.

Mounted cards are discovered from `/Volumes` on macOS, removable-drive letters on Windows, and `/media` or `/run/media` on Linux. The folder picker is available on every platform. OS permissions still apply. Reconnect a disconnected card and retry the preview, or reopen its folder to rescan.

## Checks and packaging

```sh
npm test             # events, pairing, selection, export and collision handling
npm run build        # type checks and production builds
npm run test:desktop # Electron end-to-end checks; requires a desktop session
npm run dist         # build an installer for the current OS
```

Desktop tests cover the Settings panel and unavailable-Ollama warnings, date/time hierarchy, theme persistence, and thumbnails and full view, arrow navigation, both video-seek modifiers, multi-selection, drag selection, persistent accept/reject marks, long event lists, selected/accepted exports, filters/search, EXIF metadata, an overnight event, JPEG/RAW switching using a synthetic DNG preview container, original-file hashes, and video keyboard controls using a generated VP8 clip. Ollama inference and the Photos native boundary are verified with mocks; tests never import into your actual Photos library. Live inference on a supported local Ollama installation and a real Photos import still need validation. Camera-specific RAW variants and physical card hardware also need testing with representative real-world files.

Packaging uses electron-builder (DMG/ZIP on macOS, NSIS on Windows, AppImage on Linux). Release installers need platform signing credentials for normal public distribution. ExifTool requires Perl on macOS/Linux; Windows uses its bundled executable. Temporary JPEG previews are generated outside the card. No cloud account or network connection is needed for review.

### GitHub Actions builds

Three independent workflows build the app on native GitHub-hosted runners:

| Workflow | Architectures | Downloadable installers |
| --- | --- | --- |
| [Build macOS](.github/workflows/build-macos.yml) | Apple Silicon (arm64), Intel (x64) | DMG and ZIP for each architecture |
| [Build Linux](.github/workflows/build-linux.yml) | x64 | AppImage |
| [Build Windows](.github/workflows/build-windows.yml) | x64 | NSIS EXE |

Each workflow runs on pushes to `main`, `v*` tags, pull requests targeting `main`, or **Run workflow** in the repository’s Actions tab. Each native build installs locked dependencies with Node.js 24 and `npm ci`, runs unit tests, regenerates icons, builds the app, and packages its installer. The macOS architectures use separate native runners so Sharp’s native binaries match the target.

Download installers from the run’s **Artifacts** section; artifacts are kept for seven days. CI builds are unsigned and do not publish GitHub Releases. No signing or publishing secrets are required. Action dependencies are pinned to verified commit hashes, and workflow tokens have read-only repository permissions. Desktop UI tests remain available through `npm run test:desktop` and are not part of these installer workflows.

## Sample photo credits

The offline demo includes nature photographs downloaded from [Unsplash](https://unsplash.com/license). Source images: [mountains](https://images.unsplash.com/photo-1464822759023-fed622ff2c3b), [wildlife landscape](https://images.unsplash.com/photo-1472396961693-142e6e269027), [forest](https://images.unsplash.com/photo-1441974231531-c6227db76b6e), [lakeside](https://images.unsplash.com/photo-1470770841072-f978cf4d019e), [misty sunrise](https://images.unsplash.com/photo-1470252649378-9c29740c9fa8), and [mountain valley](https://images.unsplash.com/photo-1469474968028-56623f02e42e). The sample filenames and metadata are illustrative.

## License

Copyright © 2026 Juti Noppornpitak.

Photo Proofer is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party dependencies and sample photographs retain their own licenses and credits.

Background AI failures appear in a red, dismissible error panel without opening Settings or selecting the affected photo. The panel includes the file or event and the reported error, retains separate failures until dismissed, and also reports unexpected application errors. Indexing warnings identify unreadable files/folders and metadata failures; one unreadable item does not stop the rest of the scan.
