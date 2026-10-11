# README media

Every GIF here is recorded against a synthetic demo store (the benchmark corpus from
`src/bench/corpus.ts`, imported into a throwaway `CARAFE_HOME`), so no real session
appears. `cli.tape` and `skill.tape` are [vhs](https://github.com/charmbracelet/vhs)
scripts: `vhs cli.tape` re-records the GIF. `menubar.gif` is a screen recording of the
menu bar app pointed at the same store, cropped with ffmpeg to the menu and the window.
