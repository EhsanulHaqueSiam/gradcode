@echo off
rem The `getmyprof` command in a Windows release zip: runs cli.mjs on the node.exe beside it.
"%~dp0node.exe" "%~dp0cli.mjs" %*
