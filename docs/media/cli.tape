Output cli.gif
Set Shell zsh
Env CARAFE_HOME "/tmp/carafe-demo/home/.carafe"
Env CARAFE_CC_ROOT "/tmp/carafe-demo/src/claude"
Env CARAFE_CODEX_ROOT "/tmp/carafe-demo/src/codex"
Env CARAFE_NO_UPDATE_CHECK "1"
Env PATH "/tmp/carafe-demo/bin:/opt/homebrew/bin:/usr/bin:/bin"
Set FontSize 14
Set Width 1200
Set Height 620
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Padding 18
Hide
Type "cd /tmp/carafe-demo/work && clear" Enter
Show
Type "carafe list" Sleep 300ms Enter
Sleep 2.5s
Type "carafe search 'stale cache key'" Sleep 300ms Enter
Sleep 3s
Type "carafe handoff latest" Sleep 300ms Enter
Sleep 14s
Sleep 3s
