# Mini Audio Suite

Scenes this plugin treats as audio, and the tag that marks them.

## Language

**Scene**:
A Stash scene, the library object that owns one or more files.
_Avoid_: file, item

**Audio tag**:
The tag whose name equals the plugin tag setting, compared without regard to case. The default name is Audio.
_Avoid_: alias, audio label

**Real video stream**:
A video stream other than attached cover art.
_Avoid_: video content, video file

**Audio Scene**:
A Scene that has the Audio tag or any tag nested under it at any depth, or that has at least one file and whose files all lack a real video stream.
_Avoid_: audio file, audio item
