#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

#define AppName "BitChat Desktop Community Preview"
#define AppPublisher "BitChat Community Contributors"
#define AppExecutable "bitchat-desktop.exe"

[Setup]
AppId={{94D58F5C-CC1C-49A9-8421-7C98CECD167D}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\BitChat Desktop Community Preview
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=dist\installer
OutputBaseFilename=bitchat-desktop-{#AppVersion}-windows-x64-setup
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
SetupLogging=yes
UninstallDisplayIcon={app}\{#AppExecutable}
WizardStyle=modern

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Créer une icône sur le Bureau"; GroupDescription: "Icônes supplémentaires :"; Flags: unchecked

[Files]
Source: "dist\bitchat-desktop-win32-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExecutable}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExecutable}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExecutable}"; Description: "Lancer {#AppName}"; Flags: nowait postinstall skipifsilent
