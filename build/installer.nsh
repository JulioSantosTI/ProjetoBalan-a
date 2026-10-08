; Pagina extra do instalador: senha do Agente WMS desta maquina.
; Cada maquina tem a sua senha, definida aqui. Depois de copiar os arquivos o
; instalador chama o app com --definir-senha, que grava so o hash em
; C:\ProgramData\AgenteWMS\senha.json (ver electron/senhaMaster.js).

!ifndef BUILD_UNINSTALLER

!include nsDialogs.nsh
!include LogicLib.nsh
!include WinMessages.nsh

Var SenhaDialog
Var SenhaCampo
Var ConfirmaCampo
Var MostrarCheck
Var SenhaAgente

; Expandida pelo electron-builder ja com o MUI carregado (MUI_HEADER_TEXT so
; existe a partir dai), por isso as funcoes da pagina ficam aqui dentro.
!macro customPageAfterChangeDir
  Page custom SenhaPaginaCriar SenhaPaginaSair

Function SenhaPaginaCriar
  !insertmacro MUI_HEADER_TEXT "Senha do Agente WMS" "Defina a senha que protege as configurações desta máquina."

  nsDialogs::Create 1018
  Pop $SenhaDialog
  ${If} $SenhaDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 26u "Esta senha será pedida para abrir as configurações do agente (impressoras e balança) e para fechá-lo neste computador. Anote e guarde com o TI: para trocá-la é preciso reinstalar."
  Pop $0

  ${NSD_CreateLabel} 0 34u 100% 10u "Senha (mínimo 6 caracteres)"
  Pop $0
  ${NSD_CreatePassword} 0 46u 60% 13u ""
  Pop $SenhaCampo

  ${NSD_CreateLabel} 0 66u 100% 10u "Confirmar senha"
  Pop $0
  ${NSD_CreatePassword} 0 78u 60% 13u ""
  Pop $ConfirmaCampo

  ${NSD_CreateCheckbox} 0 98u 100% 11u "Mostrar senha"
  Pop $MostrarCheck
  ${NSD_OnClick} $MostrarCheck SenhaMostrarClique

  ${NSD_SetFocus} $SenhaCampo
  nsDialogs::Show
FunctionEnd

Function SenhaMostrarClique
  ${NSD_GetState} $MostrarCheck $0
  ${If} $0 == ${BST_CHECKED}
    SendMessage $SenhaCampo ${EM_SETPASSWORDCHAR} 0 0
    SendMessage $ConfirmaCampo ${EM_SETPASSWORDCHAR} 0 0
  ${Else}
    ; 9679 = "●"
    SendMessage $SenhaCampo ${EM_SETPASSWORDCHAR} 9679 0
    SendMessage $ConfirmaCampo ${EM_SETPASSWORDCHAR} 9679 0
  ${EndIf}
  ; O Windows so redesenha o campo com o novo caractere depois disso.
  System::Call "user32::InvalidateRect(p $SenhaCampo, p 0, i 1)"
  System::Call "user32::InvalidateRect(p $ConfirmaCampo, p 0, i 1)"
FunctionEnd

Function SenhaPaginaSair
  ${NSD_GetText} $SenhaCampo $0
  ${NSD_GetText} $ConfirmaCampo $1

  StrLen $2 $0
  ${If} $2 < 6
    MessageBox MB_ICONEXCLAMATION|MB_OK "A senha precisa ter pelo menos 6 caracteres."
    Abort
  ${EndIf}

  ; S!= compara diferenciando maiusculas de minusculas.
  ${If} $0 S!= $1
    MessageBox MB_ICONEXCLAMATION|MB_OK "As senhas não conferem. Digite a mesma senha nos dois campos."
    Abort
  ${EndIf}

  StrCpy $SenhaAgente $0
FunctionEnd
!macroend

!macro customInstall
  ; Instalacao silenciosa (/S) pula a pagina: mantem a senha que ja existir.
  ${If} $SenhaAgente != ""
    ; Vai por variavel de ambiente (herdada pelo processo filho) para a senha
    ; nao aparecer na linha de comando.
    System::Call 'Kernel32::SetEnvironmentVariable(t "AGENTE_WMS_NOVA_SENHA", t "$SenhaAgente") i'
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --definir-senha' $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "AGENTE_WMS_NOVA_SENHA", p 0) i'
    StrCpy $SenhaAgente ""
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "Não foi possível gravar a senha do agente (código $0). Reinstale o Agente WMS."
    ${EndIf}
  ${EndIf}
!macroend

!endif
