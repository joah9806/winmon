Set fso = CreateObject("Scripting.FileSystemObject")
Set ws = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
ws.CurrentDirectory = root
If Not fso.FolderExists(root & "\data") Then fso.CreateFolder(root & "\data")

' Same architecture rule as pick-node.bat: only a pure 32-bit OS uses node-x86.
nodeExe = "runtime\node.exe"
arch = LCase(ws.ExpandEnvironmentStrings("%PROCESSOR_ARCHITECTURE%"))
wow = ws.ExpandEnvironmentStrings("%PROCESSOR_ARCHITEW6432%")
If arch = "x86" And (wow = "" Or wow = "%PROCESSOR_ARCHITEW6432%") Then
  If fso.FileExists(root & "\runtime\node-x86.exe") Then nodeExe = "runtime\node-x86.exe"
End If

ws.Run "cmd.exe /c " & nodeExe & " server.js >> data\server.log 2>&1", 0, False