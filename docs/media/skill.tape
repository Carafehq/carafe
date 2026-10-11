Output skill.gif
Set Shell zsh
Env CARAFE_HOME "/tmp/carafe-demo/home/.carafe"
Env CARAFE_CC_ROOT "/tmp/carafe-demo/src/claude"
Env CARAFE_CODEX_ROOT "/tmp/carafe-demo/src/codex"
Env CARAFE_NO_UPDATE_CHECK "1"
Env PATH "/tmp/carafe-demo/bin:/opt/homebrew/bin:/usr/bin:/bin"
Set FontSize 15
Set Width 1100
Set Height 680
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Padding 18
Hide
Type "unset CLAUDE_CODE_CHILD_SESSION CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT; cd /tmp/carafe-demo/work && clear" Enter
Sleep 500ms
Type "claude --allowedTools 'Bash(carafe:*)' --strict-mcp-config --mcp-config /tmp/carafe-demo/empty-mcp.json" Enter
Sleep 6s
Down
Sleep 300ms
Enter
Sleep 7s
Show
Sleep 1s
Type "/carafe search 'stale cache key'" Sleep 400ms Enter
Sleep 45s
Sleep 3s
