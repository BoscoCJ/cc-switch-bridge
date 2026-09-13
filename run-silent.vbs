Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
serverPath = scriptDir & "\server.js"
configPath = scriptDir & "\config.json"
logPath = scriptDir & "\bridge-startup.log"

' Check required files
If Not fso.FileExists(serverPath) Then
    MsgBox "CC Switch Bridge: server.js not found in " & scriptDir, vbCritical, "Error"
    WScript.Quit 1
End If

If Not fso.FileExists(configPath) Then
    MsgBox "CC Switch Bridge: config.json not found." & vbCrLf & _
           "Please copy config.example.json to config.json and edit it.", vbCritical, "Error"
    WScript.Quit 1
End If

' Find Node.js
nodePath = ""

' 1. System PATH
On Error Resume Next
Set exec = shell.Exec("node --version")
If Err.Number = 0 Then
    ver = exec.StdOut.ReadAll
    If exec.ExitCode = 0 Then
        nodePath = "node"
    End If
End If
On Error GoTo 0

' 2. WorkBuddy bundled Node
If nodePath = "" Then
    wbBase = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.workbuddy\binaries\node\versions"
    If fso.FolderExists(wbBase) Then
        For Each f In fso.GetFolder(wbBase).SubFolders
            nodeExe = f.Path & "\node.exe"
            If fso.FileExists(nodeExe) Then
                nodePath = nodeExe
                Exit For
            End If
        Next
    End If
End If

' 3. Common paths
If nodePath = "" Then
    If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
        nodePath = "C:\Program Files\nodejs\node.exe"
    ElseIf fso.FileExists("C:\Program Files (x86)\nodejs\node.exe") Then
        nodePath = "C:\Program Files (x86)\nodejs\node.exe"
    End If
End If

If nodePath = "" Then
    MsgBox "CC Switch Bridge: Node.js not found." & vbCrLf & _
           "Please install Node.js 18+ from https://nodejs.org", vbCritical, "Error"
    WScript.Quit 1
End If

' Build command
If nodePath = "node" Then
    cmd = "node.exe """ & serverPath & """ --config """ & configPath & """"
Else
    cmd = """" & nodePath & """ """ & serverPath & """ --config """ & configPath & """"
End If

' Start silently
On Error Resume Next
shell.Run cmd, 0, False
If Err.Number <> 0 Then
    MsgBox "CC Switch Bridge: Failed to start." & vbCrLf & _
           "Error: " & Err.Description, vbCritical, "Error"
    WScript.Quit 1
End If
On Error GoTo 0

' Write PID file for stop script
Set pidFile = fso.CreateTextFile(scriptDir & "\bridge.pid", True)
pidFile.WriteLine Now
pidFile.Close
