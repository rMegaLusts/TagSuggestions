---
status: accepted
---

# Audio membership is a findScenes filter

Mini Audio Suite has to select Scenes by tag hierarchy or by the absence of a video codec, and the scene grid has to show that selection. Stash's `findScenes` scene filter expresses that rule and runs it as SQL. Direct SQL against the Stash database was the alternative, and it would sit outside the query the scene grid already performs.

## Considered Options

- Direct SQL. It can see stream rows the scene filter cannot, and this rule does not need that. It would also force a backend plugin beside the UI.
- Tag-only filtering. It misses audio files that were never tagged, which is the case the file side of the rule exists for.

## Consequences

A scene-level `video_codec` criterion matches when any file matches. `IS_NULL` would therefore include a Scene that has both a video file and an audio file. The no-video side is the negation of "some file has a video codec", plus at least one file. Stash treats a blank codec as null. Attached cover art is already omitted from the stored video codec.
