; MeetScribe NSIS hooks — ensure meetscribe:// launches the installed app
; (electron-builder includes this from buildResources when nsis.include is set)

!macro customInstall
  DetailPrint "Registering meetscribe:// protocol handler"
  WriteRegStr HKCU "Software\Classes\meetscribe" "" "URL:MeetScribe Protocol"
  WriteRegStr HKCU "Software\Classes\meetscribe" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\meetscribe\DefaultIcon" "" "$INSTDIR\MeetScribe.exe,0"
  WriteRegStr HKCU "Software\Classes\meetscribe\shell\open\command" "" '"$INSTDIR\MeetScribe.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\novameet" "" "URL:MeetScribe Protocol (legacy)"
  WriteRegStr HKCU "Software\Classes\novameet" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\novameet\DefaultIcon" "" "$INSTDIR\MeetScribe.exe,0"
  WriteRegStr HKCU "Software\Classes\novameet\shell\open\command" "" '"$INSTDIR\MeetScribe.exe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\meetscribe"
  DeleteRegKey HKCU "Software\Classes\novameet"
!macroend
