' CC Switch Bridge - Windows 静默启动脚本
' 自动检测 Node.js 路径，无控制台窗口运行

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' 获取脚本所在目录
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' 自动检测 Node.js
nodePath = FindNode()
If nodePath = "" Then
    MsgBox "CC Switch Bridge: 未找到 Node.js，请先安装 Node.js 18+", vbCritical, "启动失败"
    WScript.Quit 1
End If

serverPath = fso.BuildPath(scriptDir, "server.js")
configPath = fso.BuildPath(scriptDir, "config.json")

' 静默运行（第二个参数 0 = 隐藏窗口）
cmd = """" & nodePath & """ """ & serverPath & """ --config """ & configPath & """"
shell.Run cmd, 0, False

Function FindNode()
    ' 优先级：
    ' 1. 系统 PATH 中的 node
    ' 2. WorkBuddy 自带 Node
    ' 3. nvm for Windows
    ' 4. 常见安装路径
    
    ' 1. 系统 PATH
    On Error Resume Next
    Set exec = shell.Exec("node --version")
    If Err.Number = 0 Then
        exec.StdOut.ReadAll
        If exec.ExitCode = 0 Then
            FindNode = "node"
            Exit Function
        End If
    End If
    On Error GoTo 0
    
    ' 2. WorkBuddy 自带 Node（搜索 versions 目录）
    wbNodeBase = fso.BuildPath(shell.ExpandEnvironmentStrings("%USERPROFILE%"), ".workbuddy\binaries\node\versions")
    If fso.FolderExists(wbNodeBase) Then
        For Each verFolder In fso.GetFolder(wbNodeBase).SubFolders
            nodeExe = fso.BuildPath(verFolder, "node.exe")
            If fso.FileExists(nodeExe) Then
                FindNode = nodeExe
                Exit Function
            End If
        Next
    End If
    
    ' 3. nvm for Windows
    nvmSymlink = shell.ExpandEnvironmentStrings("%PROGRAMFILES%") & "\nodejs\node.exe"
    If fso.FileExists(nvmSymlink) Then
        FindNode = nvmSymlink
        Exit Function
    End If
    
    ' 4. 常见路径
    Dim commonPaths
    commonPaths = Array( _
        shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\fnm_multishells\*\node.exe", _
        "C:\Program Files\nodejs\node.exe", _
        "C:\nodejs\node.exe" _
    )
    
    For Each pattern In commonPaths
        ' 简单通配符匹配
        Set folder = fso.GetParentFolderName(pattern)
        If fso.FolderExists(folder) Then
            For Each f In fso.GetFolder(folder).Files
                If LCase(f.Name) = "node.exe" Then
                    FindNode = f.Path
                    Exit Function
                End If
            Next
        End If
    Next
    
    FindNode = ""
End Function
