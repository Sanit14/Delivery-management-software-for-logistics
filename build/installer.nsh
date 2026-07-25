; installer.nsh — auto-included by electron-builder's NSIS target by convention
; (build/installer.nsh, no package.json change needed). Adds ONE custom page,
; right after the existing app-install-location page, for the data folder —
; then on file-install writes the choice to the SAME shared config bootstrap.cjs
; already reads (%ProgramData%\DeliveryManager\root.json, key "root"). Do not
; add a second config file/shape — see bootstrap.cjs for why.
;
; App install location (page 1, built-in via allowToChangeInstallationDirectory
; in package.json, default C:\Program Files\DeliveryManager) is untouched here.

!include MUI2.nsh
!include LogicLib.nsh
!include nsDialogs.nsh

Var DataDir
Var DataDirHwnd
Var InstDirDrive
Var DataDirDrive

; ── Data folder page (after the app-location page, before file copy) ──────────
!macro customPageAfterChangeDir
  Page custom PageDataDirCreate PageDataDirLeave
!macroend

Function PageDataDirCreate
  !insertmacro MUI_HEADER_TEXT "Choose Data Folder" "Choose where DeliveryManager will store its database, backups and reports."

  ${If} $DataDir == ""
    StrCpy $DataDir "D:\DeliveryManagerData"
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "All DeliveryManager data (database, backups, reports) is kept in ONE folder. This must be the SAME folder for every computer/seat using this app on this server."
  Pop $0

  ${NSD_CreateDirRequest} 0 32u 76% 12u "$DataDir"
  Pop $DataDirHwnd

  ${NSD_CreateBrowseButton} 78% 31u 22% 13u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 PageDataDirBrowse

  ${NSD_CreateLabel} 0 52u 100% 56u "Do not keep the application and the data folder on the same drive. Recommended: install the application on the C: drive and place the data folder on the D: drive. Keeping your data on a separate drive protects your records if the system drive ever needs to be reinstalled."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function PageDataDirBrowse
  ${NSD_GetText} $DataDirHwnd $DataDir
  nsDialogs::SelectFolderDialog "Choose data folder (same for all computers/seats)" "$DataDir"
  Pop $0
  ${If} $0 != error
    StrCpy $DataDir "$0"
    ${NSD_SetText} $DataDirHwnd "$DataDir"
  ${EndIf}
FunctionEnd

Function PageDataDirLeave
  ${NSD_GetText} $DataDirHwnd $DataDir
  ${If} $DataDir == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "Please choose a data folder."
    Abort
  ${EndIf}

  ; Same-drive check — non-blocking caution, proceeding is still allowed.
  StrCpy $InstDirDrive "$INSTDIR" 2
  StrCpy $DataDirDrive "$DataDir" 2
  ${If} $InstDirDrive == $DataDirDrive
    MessageBox MB_OK|MB_ICONINFORMATION "The application and the data folder are both on drive $InstDirDrive — this will still work, but keeping your data on a separate drive protects your records if the system drive ever needs to be reinstalled."
  ${EndIf}
FunctionEnd

; ── Escape backslashes for embedding a Windows path in a JSON string value ────
; (Windows paths only ever contain backslashes as a JSON-special character —
; no quotes to worry about.)
Var EscIn
Var EscOut
Var EscLen
Var EscIdx
Var EscChar

Function EscapeJsonPath
  Exch $EscIn
  StrCpy $EscOut ""
  StrLen $EscLen $EscIn
  StrCpy $EscIdx 0
  ${Do}
    ${If} $EscIdx >= $EscLen
      ${Break}
    ${EndIf}
    StrCpy $EscChar $EscIn 1 $EscIdx
    ${If} $EscChar == "\"
      StrCpy $EscOut "$EscOut\\"
    ${Else}
      StrCpy $EscOut "$EscOut$EscChar"
    ${EndIf}
    IntOp $EscIdx $EscIdx + 1
  ${Loop}
  Exch $EscOut
FunctionEnd

; ── On finish: write shared config + logs folder (with ACL) ───────────────────
Var ProgramDataDir
Var EscapedDataDir
Var ConfigFileHandle
Var IcaclsExitCode

!macro customInstall
  ; Shared per-machine pointer — SAME file/shape bootstrap.cjs already reads
  ; (getConfiguredRoot / saveRoot). Do not introduce a second config file.
  ExpandEnvStrings $ProgramDataDir "%ProgramData%"

  ; ── Clear the stale pointer + last-known-good markers left by any PREVIOUS
  ; install (mirrors bootstrap.cjs clearConfiguredRoot / safeguard.cjs
  ; writeLastGood — same files, cleared the same way) ────────────────────────
  ; Uninstall does not remove these. Without this, a fresh install after an
  ; uninstall would have resolveDataRoot() in main.cjs silently reuse the OLD
  ; root.json and open straight into that old folder's leftover db — and if
  ; that folder's db is now empty but its lastGood-*.json marker still
  ; remembers real data, the blank-DB guard trips safe mode instead of a
  ; clean first run. Deleting both here (before the fresh write below)
  ; forces every install to start from a clean pointer; recovery of real
  ; data, if any, stays a deliberate Settings -> Restore, never automatic.
  ; Does NOT touch the user's actual data folder (e.g. D:\DeliveryManagerData)
  ; — only these ProgramData pointer/marker files.
  Delete "$ProgramDataDir\DeliveryManager\root.json"
  Delete "$ProgramDataDir\DeliveryManager\lastGood-*.json"

  CreateDirectory "$ProgramDataDir\DeliveryManager"

  Push "$DataDir"
  Call EscapeJsonPath
  Pop $EscapedDataDir

  FileOpen $ConfigFileHandle "$ProgramDataDir\DeliveryManager\root.json" w
  FileWrite $ConfigFileHandle '{$\r$\n  "root": "$EscapedDataDir"$\r$\n}$\r$\n'
  FileClose $ConfigFileHandle

  ; Fixed keeper.log home. An elevated installer creating a folder directly
  ; under C:\ does NOT give normal (non-admin) accounts write access — every
  ; other NComputing seat would get EPERM the moment the keeper tries to
  ; append. Grant the built-in Users group (well-known SID, locale-independent)
  ; Modify, inherited onto files created later.
  CreateDirectory "C:\DeliveryManagerLogs"
  nsExec::ExecToLog 'icacls "C:\DeliveryManagerLogs" /grant *S-1-5-32-545:(OI)(CI)M'
  Pop $IcaclsExitCode
!macroend

; ── Uninstall: warn, read data path, remove config + logs + data folder ───────
; Variables shared between the read step and the delete step.
Var UnProgramDataDir   ; expands %ProgramData% at runtime
Var RootJsonHandle     ; file handle for reading root.json
Var RootJsonLine       ; one line read from root.json
Var RawDataPath        ; extracted path (still JSON-escaped: \\ -> \)
Var DataFolderPath     ; final path after un-escaping

!macro customUninstall

  ; Kill any running keeper or app processes to release file locks so the uninstaller can delete the files
  nsExec::Exec 'taskkill /f /im DeliveryManager.exe'
  Sleep 1000

  ; ── Step 1: warn the user BEFORE touching any data ──────────────────────────
  MessageBox MB_YESNO|MB_ICONEXCLAMATION \
    "This will PERMANENTLY DELETE all DeliveryManager data on this computer \
— the database, local backups, and settings.$\r$\n$\r$\n\
Make sure you have a backup on a pendrive or another drive BEFORE continuing. \
This cannot be undone.$\r$\n$\r$\nContinue with full removal?" \
    IDNO skip_data_deletion

  ; ── Step 2: read data path from root.json BEFORE deleting it ────────────────
  ; root.json lives in %ProgramData%\DeliveryManager\root.json.
  ; It is a two-line JSON: { "root": "D:\\DeliveryManagerData" }
  ; Strategy: FileRead the file line by line. The line containing "root" holds
  ; the path. Extract what is between the first " after the : and the last "
  ; on that line. Then replace every \\ with \ to un-escape the JSON value.
  ; If the file is missing or unreadable, $DataFolderPath stays "" and the
  ; data-folder deletion is skipped (no guessed/hard-coded fallback).

  ExpandEnvStrings $UnProgramDataDir "%ProgramData%"
  StrCpy $DataFolderPath ""   ; default: unknown — skip data-folder deletion

  ClearErrors
  FileOpen $RootJsonHandle "$UnProgramDataDir\DeliveryManager\root.json" r
  ${IfNot} ${Errors}
    ; Read lines until EOF looking for the one containing "root":
    ${Do}
      FileRead $RootJsonHandle $RootJsonLine
      ${If} ${Errors}
        ${Break}   ; EOF or read error — stop scanning
      ${EndIf}

      ; Does this line contain the key "root"?
      ${If} $RootJsonLine != ""
        StrCpy $0 $RootJsonLine   ; working copy
        ; Find ": "" — look for the colon-quote sequence after "root"
        ; We extract everything between the FIRST " that follows the : and the
        ; LAST " on the line (trimming the closing quote + any \r\n).
        ; NSIS StrStr gives the position of a substring; we use it to locate
        ; the opening quote of the value.
        Push $0
        Push '"root"'
        Call un.StrStr
        Pop $1        ; $1 = substring starting at "root" or "" if not found
        ${If} $1 != ""
          ; Now find the first " after the colon in $1:
          Push $1
          Push ': "'
          Call un.StrStr
          Pop $2      ; $2 = ': "D:\\...' portion
          ${If} $2 != ""
            ; Strip the leading ': "' (3 chars) to reach the raw value:
            StrCpy $RawDataPath $2 "" 3
            ; $RawDataPath is now: D:\\DeliveryManagerData"\r\n
            ; Trim from the first closing " onward:
            Push $RawDataPath
            Push '"'
            Call un.StrStr
            Pop $3    ; $3 = '"...' — everything from closing quote
            ${If} $3 != ""
              StrLen $4 $3          ; length of tail starting at "
              StrLen $5 $RawDataPath
              IntOp $5 $5 - $4      ; chars before the closing "
              StrCpy $RawDataPath $RawDataPath $5   ; trim the tail
            ${EndIf}
            ; Un-escape JSON: replace \\ with \ using a character-by-character loop
            StrCpy $DataFolderPath ""
            StrLen $6 $RawDataPath
            StrCpy $7 0   ; index
            ${Do}
              ${If} $7 >= $6
                ${Break}
              ${EndIf}
              StrCpy $8 $RawDataPath 1 $7   ; current char
              IntOp $9 $7 + 1               ; peek-ahead index
              ${If} $8 == "\"
                ${If} $9 < $6
                  StrCpy $8 $RawDataPath 1 $9   ; next char
                  ${If} $8 == "\"
                    ; Found \\ — emit single \ and advance past both chars
                    StrCpy $DataFolderPath "$DataFolderPath\"
                    IntOp $7 $7 + 2
                    ${Continue}
                  ${EndIf}
                ${EndIf}
              ${EndIf}
              StrCpy $DataFolderPath "$DataFolderPath$8"
              IntOp $7 $7 + 1
            ${Loop}
            ${Break}   ; found and parsed — stop reading further lines
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${Loop}
    FileClose $RootJsonHandle
  ${EndIf}

  ; ── Step 3: remove ProgramData config + audit logs ──────────────────────────
  ; RMDir /r removes the whole DeliveryManager folder recursively — including
  ; root.json, lastGood-*.json, audit-config.json, and the audit\ subfolder
  ; (monthly .log files). Plain RMDir (no /r) silently fails when the folder is
  ; non-empty, leaving all of those files behind after uninstall.
  RMDir /r "$UnProgramDataDir\DeliveryManager"

  ; ── Step 4: remove the fixed logs folder ────────────────────────────────────
  RMDir /r "C:\DeliveryManagerLogs"

  ; ── Step 5: remove the data folder (only if a path was successfully parsed) ─
  ${If} $DataFolderPath != ""
    RMDir /r "$DataFolderPath"
  ${Else}
    ; root.json was missing or unreadable — the data folder location is
    ; unknown. Skip deletion rather than guessing. The user can remove it
    ; manually from wherever they placed it during installation.
    MessageBox MB_OK|MB_ICONINFORMATION \
      "Note: the data folder could not be located (root.json was missing or \
unreadable). The application files, config, and logs have been removed. \
Please manually delete the data folder you chose during installation."
  ${EndIf}

  Goto end_uninstall

skip_data_deletion:
  ; User chose NO — program files are still removed by electron-builder
  ; as normal, but data folder / ProgramData / logs are left untouched.

end_uninstall:

!macroend

; ── Helper: find substring in string (uninstaller namespace) ─────────────────
; Called as: Push haystack / Push needle / Call un.StrStr / Pop result
; result = substring of haystack starting at needle, or "" if not found.
Function un.StrStr
  Exch $R1   ; needle
  Exch
  Exch $R0   ; haystack
  Push $R2
  Push $R3
  Push $R4

  StrLen $R3 $R1   ; needle length
  StrCpy $R2 0

  ${Do}
    StrCpy $R4 $R0 $R3 $R2
    ${If} $R4 == $R1
      StrCpy $R0 $R0 "" $R2   ; return from match position
      ${Break}
    ${EndIf}
    StrLen $R4 $R0
    IntOp $R4 $R4 - $R2
    ${If} $R4 <= $R3
      StrCpy $R0 ""
      ${Break}
    ${EndIf}
    IntOp $R2 $R2 + 1
  ${Loop}

  Pop $R4
  Pop $R3
  Pop $R2
  Exch $R0
  Exch
  Pop $R1
FunctionEnd
