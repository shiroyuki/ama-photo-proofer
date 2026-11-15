# Photo Proofer

A desktop workspace for reviewing photos and videos directly from a memory card. Built with Electron, TypeScript, and Vite. All scanning and preview processing happens locally. Opening a card never imports, moves, edits, or deletes its files.

## Run

Use Node.js 22.18+ or 24+ and npm.

```sh
npm install
npm start
```

Open a mounted memory card from the sidebar, or choose **Open folder** and select the card or its DCIM folder. Subfolders are scanned automatically. The app opens in thumbnail view. **Explore a sample collection** works offline and uses illustrative metadata.

For development, `npm run dev` starts Vite and Electron. Changes to the Electron code require restarting that command. The renderer can also be previewed in a browser with `npx vite`; native folder access is available only in Electron.

## Appearance

Open **Settings** at the bottom of the sidebar. The **Theme** switcher offers **System**, **Light**, and **Dark**. System is the default and follows operating-system changes while the app is open. An explicit choice is remembered across launches and applies to native windows and dialogs as well as the photo workspace. Photographs and the logo keep their original colors.

## Review

- Captures are sorted by their taken timestamp. Events are grouped under ISO date headings, then ordered by time within each date, in both the sidebar and thumbnail browser. A gap **greater than** 30 minutes starts a new event. Exactly 30 minutes stays together. Adjacent captures continue across midnight in the same event under the starting date, with the ending date displayed.
- A JPEG and RAW sharing a filename stem in the same folder appear as one capture. JPEG opens by default. Choose RAW in the details panel or press **T** to switch the selected capture. Different directories and videos stay separate.
- Click a thumbnail to select it and see its metadata; click the sole selected thumbnail again to deselect it. A plain click replaces a group selection. Cmd/Ctrl-click toggles individual captures, Shift-click selects an anchored range in the current sort order, and Cmd/Ctrl+Shift-click adds a range. Drag a selection box across thumbnails; Cmd/Ctrl/Shift-drag adds to the selection, and dragging near the top or bottom scrolls the grid.
- Double-click or press **Enter** to open a single selected capture in the viewer. Arrow keys browse photos and videos. Changing the event or media filter clears the selection; search retains only visible selected captures.
- Press **S** to accept the selection or **D** to reject it. Use **Clear status** to return to unreviewed. Review marks are stored locally in the app and restored when the same files are reopened; they do not write to the card.
- Use the media filters, filename/camera/lens search, chronological sort, and thumbnail size slider to browse. The app can be used while a large card is still being scanned.
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
| S / D | Accept / reject selected captures |
| Cmd / Ctrl + A | Select all visible captures |
| ? | Show keyboard shortcuts |

## Export

Choose **Export** in the header, then **Selected captures** or **Accepted captures**. Accepted export includes all accepted captures from the currently opened source, including those outside the current event or search. Review marks and exports apply to a paired JPEG/RAW capture as a unit; both original files are copied. Original videos are copied as well.

The destination defaults to your system **Pictures** folder. **Choose folder** opens the native folder picker, and the location is remembered across app launches. Export copies originals without recompression, preserves existing destination files, and adds numbered suffixes to duplicate filenames. A progress indicator shows the current file. **Stop after current file** keeps copies already completed. Unreadable files are reported individually while readable files continue to export. The optional demo collection cannot be exported.

The new logo is available as a transparent [SVG](public/logo.svg) and a 1024px [PNG](public/icon.png). The outer circle has a white fill and black stroke; the inner red ring has no fill. To regenerate the PNG from the source vector, run `node scripts/icon.cjs`.

### Export to Photos (macOS)

On macOS, the export dialog also offers **Photos** as a destination for either selected or accepted captures. Both original files of JPEG/RAW pairs are submitted together, and original videos can be included. Photos uses its current library, supported formats, and duplicate checking. The original card files stay untouched. Folder remains the default destination; choosing Photos does not change the remembered export folder.

The first import may ask for permission to control Photos. If denied, allow Photo Proofer under **System Settings → Privacy & Security → Automation** and retry. Imports run in batches and **Stop after current batch** leaves work already processed by Photos in place. Photos may represent a RAW/JPEG pair as one media item and skip duplicates, so the number of library items can differ from the number of submitted files. A failed or timed-out import may have processed some files; check Photos before retrying.

## Optional Ollama photo tags

Open **Settings → Photo tagging** to enable or disable local tagging. On **macOS**, it defaults to **on when the local model is ready**; no dedicated-GPU check applies. An explicit on/off choice is remembered across launches. On Windows/Linux it remains **off by default**. Install and start [Ollama](https://ollama.com/), install the exact [gemma4:e2b](https://ollama.com/library/gemma4:e2b) model with `ollama pull gemma4:e2b`, and select **Check again**. The app never downloads models or starts the Ollama service.

The toggle is disabled with a warning when a dedicated GPU with its own video memory cannot be confirmed on **Windows/Linux**, when Ollama is unreachable at `127.0.0.1:11434`, or when the exact model is missing or does not report vision support. GPU identification is conservative: known discrete NVIDIA, AMD Radeon, or Intel Arc adapters need reported non-shared VRAM; integrated, virtual, and unknown adapters remain disabled. Cloud-backed model aliases are rejected. Eligibility is checked before enabling and before each tagging batch, and can be refreshed in Settings.

When enabled, tagging starts for the opened collection after scanning finishes, and for new collections as they are opened. JPEG is preferred for a JPEG/RAW pair. RAW-only captures use their embedded preview. A resized JPEG preview, without copied EXIF metadata, is sent to the fixed local Ollama endpoint using the [image generation API](https://docs.ollama.com/api/generate); originals and videos are never submitted. One photo is processed at a time. Tags appear in photo details and can be searched alongside filenames, cameras, and lenses. They are cached locally using file path, size, and modification time, so previously tagged, unchanged files are not inferred again. The app does not write tags into originals or onto the card.

Disabling tagging cancels in-flight inference and stops the queue. Existing tags remain available. **Tag untagged photos** retries missing tags; **Stop tagging** stops the current batch. A model or preview error appears in the selected photo's tag panel. Availability checks use Ollama's local API and [systeminformation GPU data](https://systeminformation.io/graphics.html). The renderer cannot choose a different host, model, or unapproved file path.

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

## Sample photo credits

The offline demo includes nature photographs downloaded from [Unsplash](https://unsplash.com/license). Source images: [mountains](https://images.unsplash.com/photo-1464822759023-fed622ff2c3b), [wildlife landscape](https://images.unsplash.com/photo-1472396961693-142e6e269027), [forest](https://images.unsplash.com/photo-1441974231531-c6227db76b6e), [lakeside](https://images.unsplash.com/photo-1470770841072-f978cf4d019e), [misty sunrise](https://images.unsplash.com/photo-1470252649378-9c29740c9fa8), and [mountain valley](https://images.unsplash.com/photo-1469474968028-56623f02e42e). The sample filenames and metadata are illustrative.

## License

Copyright © 2026 Juti Noppornpitak.

Photo Proofer is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party dependencies and sample photographs retain their own licenses and credits.
