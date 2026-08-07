; NSIS fixes $TEMP before .onInit, so changing it inside the same process is
; too late. When an existing installation lives on another volume, relaunch
; this installer once with TEMP/TMP already pointing to that volume.
!macro preInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/tongpin-temp-ready" $R1
  ${IfNot} ${Errors}
    Goto tongpin_bootstrap_done
  ${EndIf}

  ; Electron Builder writes the x64 installation location to this registry
  ; view. Prefer an existing installation; otherwise use the installer's own
  ; drive when it is already on another volume.
  SetRegView 64
  ReadRegStr $R2 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R2 == ""
    ReadRegStr $R2 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}

  ${If} $R2 != ""
    ${GetRoot} "$R2" $R3
    ${GetParent} "$R2" $R5
    StrCpy $R5 "$R5\.tongpin-updater-temp"
  ${Else}
    ${GetRoot} "$EXEDIR" $R3
    StrCpy $R5 "$R3\TongpinUpdaterTemp"
  ${EndIf}

  ${GetRoot} "$TEMP" $R4
  ${If} $R3 == ""
  ${OrIf} $R3 == $R4
    Goto tongpin_bootstrap_done
  ${EndIf}

  ClearErrors
  CreateDirectory "$R5"
  IfErrors tongpin_bootstrap_done

  StrCpy $R7 "$R5\tongpin-installer-bootstrap.cmd"
  ClearErrors
  FileOpen $R6 "$R7" w
  IfErrors tongpin_bootstrap_done
  FileWrite $R6 "@echo off$\r$\n"
  FileWrite $R6 "setlocal$\r$\n"
  FileWrite $R6 "set $\"TEMP=$R5$\"$\r$\n"
  FileWrite $R6 "set $\"TMP=$R5$\"$\r$\n"
  FileWrite $R6 "$\"$EXEPATH$\" $R0 /tongpin-temp-ready$\r$\n"
  FileWrite $R6 "exit /b %errorlevel%$\r$\n"
  FileClose $R6

  ExecWait '"$SYSDIR\cmd.exe" /D /S /C ""$R7""' $R6
  Delete "$R7"
  SetErrorLevel $R6
  Quit

  tongpin_bootstrap_done:
!macroend
