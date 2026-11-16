Set fso = CreateObject("Scripting.FileSystemObject")
Set ws = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
ws.CurrentDirectory = root

' Same architecture rule as pick-node.bat: only a pure 32-bit OS uses node-x86.
nodeExe = "runtime\node.exe"
arch = LCase(ws.ExpandEnvironmentStrings("%PROCESSOR_ARCHITECTURE%"))
wow = ws.ExpandEnvironmentStrings("%PROCESSOR_ARCHITEW6432%")
If arch = "x86" And (wow = "" Or wow = "%PROCESSOR_ARCHITEW6432%") Then
  If fso.FileExists(root & "\runtime\node-x86.exe") Then nodeExe = "runtime\node-x86.exe"
End If
If Not fso.FileExists(root & "\" & nodeExe) Then nodeExe = "runtime\node.exe"

' No folder creation and no ">>" redirect here on purpose: both used to raise an
' error that wscript //B swallowed when the app folder was read-only, so nothing
' happened on double-click. agent.js resolves a writable data directory and
' writes agent.log itself.
ws.Run "cmd.exe /c """ & nodeExe & """ agent.js", 0, False