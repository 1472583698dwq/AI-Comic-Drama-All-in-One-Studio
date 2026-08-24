Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)

exePath1 = currentDir & "\dist\Studio\Studio.exe"
exePath2 = currentDir & "\dist\MiniMax_AIÂþ¾çStudio\MiniMax_AIÂþ¾çStudio.exe"
pyPath = currentDir & "\launch_desktop_app.py"

If fso.FileExists(exePath1) Then
    ws.Run """" & exePath1 & """", 0, False
ElseIf fso.FileExists(exePath2) Then
    ws.Run """" & exePath2 & """", 0, False
ElseIf fso.FileExists(pyPath) Then
    ws.Run "python """ & pyPath & """", 0, False
Else
    ws.Run "cmd /c cd /d """ & currentDir & "\server"" && python run_server.py", 0, False
    WScript.Sleep 2000
    ws.Run "http://127.0.0.1:8000"
End If
