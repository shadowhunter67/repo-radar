import type { Capability, DetectionMode, PersistenceKind } from './types.js';

/**
 * Static, line-oriented detectors. Each regex runs on a single line of at most LIMITS.maxLineChars
 * characters, so matching stays bounded for hostile input. Patterns are deliberately conservative:
 * a detection means "this construct appears", never "this code is malicious".
 */
export const DETECTOR_PACK_VERSION = '0.1';

export type FileKind = 'js' | 'py' | 'go' | 'rs' | 'sh' | 'docker' | 'make' | 'yaml' | 'other';

export interface Detector {
  id: string;
  capability: Capability;
  mode: DetectionMode;
  confidence: number;
  pattern: RegExp;
  /** File kinds the detector applies to; `*` = every kind. */
  kinds: FileKind[] | '*';
  persistence?: PersistenceKind;
}

export function fileKind(path: string): FileKind {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (/^Dockerfile(?:\.[\w.-]+)?$/i.test(base) || /\.dockerfile$/i.test(base)) return 'docker';
  if (/^(?:GNUmakefile|Makefile|makefile)$/.test(base) || /\.mk$/.test(base)) return 'make';
  if (
    /\.(?:sh|bash|zsh|ksh|command|ps1|bat|cmd)$/i.test(base) ||
    /^(?:configure|install|setup|bootstrap|mvnw|gradlew)$/i.test(base) ||
    // Command text lifted out of a build file (Maven plugin configuration, Gradle task body) is scanned as shell.
    /#(?:plugin|task)\./.test(base)
  )
    return 'sh';
  if (/\.(?:[cm]?[jt]sx?)$/i.test(base)) return 'js';
  if (/\.pyw?$/i.test(base)) return 'py';
  if (/\.go$/i.test(base)) return 'go';
  if (/\.rs$/i.test(base)) return 'rs';
  if (/\.ya?ml$/i.test(base)) return 'yaml';
  return 'other';
}

const SH_CMD = String.raw`(?:^|[\s;&|(` + '`' + String.raw`$])`;

export const DETECTORS: Detector[] = [
  // ---- JavaScript / TypeScript -------------------------------------------------------------
  {
    id: 'js.child-process',
    capability: 'PROCESS_EXEC',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: ['js'],
    pattern: /\bchild_process\b|\b(?:execSync|spawnSync|execFileSync)\s*\(|\bexeca\w*\s*\(/,
  },
  {
    id: 'js.net-client',
    capability: 'NETWORK_CLIENT',
    mode: 'DIRECT',
    confidence: 0.8,
    kinds: ['js'],
    pattern:
      /\b(?:fetch|axios|got|superagent)\s*\(|\b(?:https?|net|tls|dgram)\.(?:get|request|connect|createConnection)\s*\(|\brequire\(\s*['"](?:https?|net|tls|node-fetch|axios|got)['"]\s*\)|\bfrom\s+['"](?:node:)?(?:https?|net|tls|node-fetch|axios|got|undici)['"]|\bXMLHttpRequest\b|\bnew WebSocket\(/,
  },
  {
    id: 'js.net-server',
    capability: 'NETWORK_SERVER',
    mode: 'INFERRED',
    confidence: 0.6,
    kinds: ['js'],
    pattern:
      /\bcreateServer\s*\(|\bnew WebSocketServer\b|\.listen\s*\(\s*(?:\d|port\b|PORT\b|process\.env)/,
  },
  {
    id: 'js.fs-write',
    capability: 'FILESYSTEM_WRITE',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: ['js'],
    pattern:
      /\bfs(?:\.promises)?\.(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|rename|renameSync|mkdir|mkdirSync|chmod|chmodSync|symlink|symlinkSync)\b/,
  },
  {
    id: 'js.fs-delete',
    capability: 'FILESYSTEM_DELETE',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: ['js'],
    pattern: /\bfs(?:\.promises)?\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\b|\brimraf\s*\(/,
  },
  {
    id: 'js.eval',
    capability: 'DYNAMIC_CODE_LOAD',
    mode: 'DIRECT',
    confidence: 0.9,
    kinds: ['js'],
    pattern: /(?<![.\w])eval\s*\(|\bnew\s+Function\s*\(|\bvm\.(?:runIn\w+|Script)\b/,
  },
  {
    id: 'js.dynamic-import',
    capability: 'DYNAMIC_CODE_LOAD',
    mode: 'POSSIBLE',
    confidence: 0.4,
    kinds: ['js'],
    pattern: /\bimport\s*\(\s*[^'"\s)]/,
  },
  {
    id: 'js.env',
    capability: 'ENVIRONMENT_READ',
    mode: 'DIRECT',
    confidence: 0.9,
    kinds: ['js'],
    pattern: /\bprocess\.env\b/,
  },
  {
    id: 'js.detached',
    capability: 'BACKGROUND_PROCESS',
    mode: 'DIRECT',
    confidence: 0.8,
    kinds: ['js'],
    persistence: 'detached_process',
    pattern: /\bdetached\s*:\s*true\b/,
  },

  // ---- Python --------------------------------------------------------------------------------
  {
    id: 'py.exec',
    capability: 'PROCESS_EXEC',
    mode: 'DIRECT',
    confidence: 0.9,
    kinds: ['py'],
    pattern:
      /\bsubprocess\.(?:run|call|check_call|check_output|Popen)\b|\bos\.(?:system|popen|exec[lv]p?e?|spawn\w+)\s*\(|\bpty\.spawn\b|\bPopen\s*\(/,
  },
  {
    id: 'py.net-client',
    capability: 'NETWORK_CLIENT',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: ['py'],
    pattern:
      /\brequests\.(?:get|post|put|delete|request|Session)\b|\burllib\.request\b|\burlopen\s*\(|\burlretrieve\s*\(|\bhttpx\.|\baiohttp\.ClientSession\b|\bsocket\.(?:socket|create_connection)\b|\bhttp\.client\b|\bftplib\b|\bsmtplib\b/,
  },
  {
    id: 'py.net-server',
    capability: 'NETWORK_SERVER',
    mode: 'INFERRED',
    confidence: 0.6,
    kinds: ['py'],
    pattern: /\bhttp\.server\b|\bsocketserver\b|\bapp\.run\s*\(|\buvicorn\.run\b/,
  },
  {
    id: 'py.fs-write',
    capability: 'FILESYSTEM_WRITE',
    mode: 'DIRECT',
    confidence: 0.8,
    kinds: ['py'],
    pattern:
      /\bopen\s*\([^)]{0,120},\s*['"][wa]b?\+?['"]|\bshutil\.(?:copy\w*|move)\b|\bos\.(?:chmod|rename|makedirs|symlink)\b|\.write_text\(|\.write_bytes\(/,
  },
  {
    id: 'py.fs-delete',
    capability: 'FILESYSTEM_DELETE',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: ['py'],
    pattern: /\bshutil\.rmtree\b|\bos\.(?:remove|unlink|rmdir)\b|\.unlink\(/,
  },
  {
    id: 'py.eval',
    capability: 'DYNAMIC_CODE_LOAD',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: ['py'],
    pattern: /(?<![.\w])(?:eval|exec)\s*\(|\b__import__\s*\(|\bcompile\s*\([^)]{0,60}['"]exec['"]/,
  },
  {
    id: 'py.env',
    capability: 'ENVIRONMENT_READ',
    mode: 'DIRECT',
    confidence: 0.9,
    kinds: ['py'],
    pattern: /\bos\.environ\b|\bos\.getenv\s*\(/,
  },
  {
    id: 'py.detached',
    capability: 'BACKGROUND_PROCESS',
    mode: 'DIRECT',
    confidence: 0.7,
    kinds: ['py'],
    persistence: 'detached_process',
    pattern: /\bstart_new_session\s*=\s*True\b|\bDETACHED_PROCESS\b/,
  },
  {
    id: 'py.fork',
    capability: 'BACKGROUND_PROCESS',
    mode: 'INFERRED',
    confidence: 0.6,
    kinds: ['py'],
    persistence: 'daemon_creation',
    pattern: /\bos\.fork\s*\(|\bdaemon\.DaemonContext\b/,
  },

  // ---- Go ------------------------------------------------------------------------------------
  {
    id: 'go.exec',
    capability: 'PROCESS_EXEC',
    mode: 'DIRECT',
    confidence: 0.9,
    kinds: ['go'],
    pattern: /\bexec\.Command(?:Context)?\s*\(|\bsyscall\.(?:Exec|ForkExec)\b/,
  },
  {
    id: 'go.net-client',
    capability: 'NETWORK_CLIENT',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: ['go'],
    pattern:
      /\bhttp\.(?:Get|Post|PostForm|Head|NewRequest(?:WithContext)?|DefaultClient)\b|\bnet\.(?:Dial|DialTimeout)\b|\btls\.Dial\b/,
  },
  {
    id: 'go.net-server',
    capability: 'NETWORK_SERVER',
    mode: 'DIRECT',
    confidence: 0.8,
    kinds: ['go'],
    pattern: /\bhttp\.(?:ListenAndServe(?:TLS)?)\b|\bnet\.Listen\b/,
  },
  {
    id: 'go.fs-write',
    capability: 'FILESYSTEM_WRITE',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: ['go'],
    pattern:
      /\bos\.(?:WriteFile|Create|OpenFile|Mkdir(?:All)?|Rename|Chmod|Symlink)\b|\bioutil\.WriteFile\b/,
  },
  {
    id: 'go.fs-delete',
    capability: 'FILESYSTEM_DELETE',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: ['go'],
    pattern: /\bos\.(?:Remove|RemoveAll)\b/,
  },
  {
    id: 'go.env',
    capability: 'ENVIRONMENT_READ',
    mode: 'DIRECT',
    confidence: 0.9,
    kinds: ['go'],
    pattern: /\bos\.(?:Getenv|LookupEnv|Environ)\b/,
  },
  {
    id: 'go.plugin',
    capability: 'DYNAMIC_CODE_LOAD',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: ['go'],
    pattern: /\bplugin\.Open\b/,
  },

  // ---- Rust ----------------------------------------------------------------------------------
  {
    id: 'rs.exec',
    capability: 'PROCESS_EXEC',
    mode: 'DIRECT',
    confidence: 0.9,
    kinds: ['rs'],
    pattern: /\bCommand::new\s*\(/,
  },
  {
    id: 'rs.net-client',
    capability: 'NETWORK_CLIENT',
    mode: 'DIRECT',
    confidence: 0.8,
    kinds: ['rs'],
    pattern: /\b(?:reqwest|ureq|isahc|surf)::|\bTcpStream::connect\b|\bUdpSocket\b/,
  },
  {
    id: 'rs.net-server',
    capability: 'NETWORK_SERVER',
    mode: 'DIRECT',
    confidence: 0.8,
    kinds: ['rs'],
    pattern: /\bTcpListener::bind\b|\bHttpServer::new\b/,
  },
  {
    id: 'rs.fs-write',
    capability: 'FILESYSTEM_WRITE',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: ['rs'],
    pattern:
      /\bfs::(?:write|create_dir(?:_all)?|copy|rename|set_permissions)\b|\bFile::create\b|\bOpenOptions\b/,
  },
  {
    id: 'rs.fs-delete',
    capability: 'FILESYSTEM_DELETE',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: ['rs'],
    pattern: /\bfs::(?:remove_file|remove_dir(?:_all)?)\b/,
  },
  {
    id: 'rs.env',
    capability: 'ENVIRONMENT_READ',
    mode: 'DIRECT',
    confidence: 0.9,
    kinds: ['rs'],
    pattern: /\benv::(?:var|vars|var_os)\b/,
  },
  {
    id: 'rs.dynamic',
    capability: 'DYNAMIC_CODE_LOAD',
    mode: 'DIRECT',
    confidence: 0.8,
    kinds: ['rs'],
    pattern: /\blibloading\b|\bLibrary::new\b|\bdlopen\b/,
  },

  // ---- Shell / Dockerfile / Makefile ---------------------------------------------------------
  {
    id: 'sh.download',
    capability: 'REMOTE_DOWNLOAD',
    mode: 'DIRECT',
    confidence: 0.9,
    kinds: ['sh', 'docker', 'make', 'yaml'],
    pattern: new RegExp(
      SH_CMD + String.raw`(?:curl|wget|Invoke-WebRequest|iwr|aria2c|certutil\s+-urlcache)\s`,
      'i',
    ),
  },
  {
    id: 'docker.add-url',
    capability: 'REMOTE_DOWNLOAD',
    mode: 'DIRECT',
    confidence: 0.9,
    kinds: ['docker'],
    pattern: /^\s*ADD\s+(?:--\S+\s+)*https?:\/\//,
  },
  {
    id: 'sh.eval',
    capability: 'DYNAMIC_CODE_LOAD',
    mode: 'INFERRED',
    confidence: 0.7,
    kinds: ['sh', 'make', 'docker'],
    pattern: new RegExp(SH_CMD + String.raw`eval\s|\bsource\s+<\(|\b(?:ba|z|da)?sh\s+-c\b`),
  },
  {
    id: 'sh.chmod-x',
    capability: 'BINARY_EXECUTION',
    mode: 'INFERRED',
    confidence: 0.5,
    kinds: ['sh', 'make', 'docker', 'yaml'],
    pattern: new RegExp(
      SH_CMD + String.raw`chmod\s+(?:-[A-Za-z]+\s+)*(?:\+x|[ugoa]+\+x|[0-7]?[0-7][0-7][57])\b`,
    ),
  },
  {
    id: 'sh.sudo',
    capability: 'PRIVILEGE_CHANGE',
    mode: 'DIRECT',
    confidence: 0.9,
    kinds: ['sh', 'make', 'docker', 'yaml'],
    pattern: new RegExp(SH_CMD + String.raw`(?:sudo|doas|pkexec)\s`),
  },
  {
    id: 'docker.user-root',
    capability: 'PRIVILEGE_CHANGE',
    mode: 'POSSIBLE',
    confidence: 0.4,
    kinds: ['docker'],
    pattern: /^\s*USER\s+(?:root|0)\s*$/i,
  },
  {
    id: 'sh.privileged',
    capability: 'PRIVILEGE_CHANGE',
    mode: 'DIRECT',
    confidence: 0.7,
    kinds: ['sh', 'make', 'yaml', 'docker'],
    pattern: /--privileged\b|--cap-add[= ](?:SYS_ADMIN|ALL)\b|\/var\/run\/docker\.sock/,
  },
  {
    id: 'sh.background',
    capability: 'BACKGROUND_PROCESS',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: ['sh', 'make', 'docker'],
    persistence: 'detached_process',
    pattern: new RegExp(
      SH_CMD + String.raw`(?:nohup|setsid|disown|start-stop-daemon)\b|[^&\s]\s+&\s*$`,
    ),
  },
  {
    id: 'sh.rm-recursive',
    capability: 'FILESYSTEM_DELETE',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: ['sh', 'make', 'docker'],
    pattern: new RegExp(SH_CMD + String.raw`rm\s+-[A-Za-z]*[rR]`),
  },

  // Making a file executable through a language API (used by download-chmod-exec chains).
  {
    id: 'js.chmod',
    capability: 'BINARY_EXECUTION',
    mode: 'INFERRED',
    confidence: 0.5,
    kinds: ['js'],
    pattern: /\bfs(?:\.promises)?\.chmod(?:Sync)?\s*\(|\bchmodSync\s*\(/,
  },
  {
    id: 'py.chmod',
    capability: 'BINARY_EXECUTION',
    mode: 'INFERRED',
    confidence: 0.5,
    kinds: ['py'],
    pattern: /\bos\.chmod\s*\(|\.chmod\s*\(\s*0o?7/,
  },
  {
    id: 'go.chmod',
    capability: 'BINARY_EXECUTION',
    mode: 'INFERRED',
    confidence: 0.5,
    kinds: ['go'],
    pattern: /\bos\.Chmod\s*\(/,
  },
  {
    id: 'rs.chmod',
    capability: 'BINARY_EXECUTION',
    mode: 'INFERRED',
    confidence: 0.5,
    kinds: ['rs'],
    pattern: /\bset_permissions\s*\(|\bPermissionsExt\b/,
  },

  // A shell command embedded in a string of a general-purpose language (execSync('curl ...'), os.system("wget ...")).
  {
    id: 'any.shell-download-string',
    capability: 'REMOTE_DOWNLOAD',
    mode: 'INFERRED',
    confidence: 0.75,
    kinds: ['js', 'py', 'go', 'rs'],
    pattern: /['"`][^'"`\n]{0,200}\b(?:curl|wget)\s+[^'"`\n]{0,200}['"`]/,
  },

  // ---- Credentials and browser data (any file kind) ------------------------------------------
  {
    id: 'any.credential-paths',
    capability: 'CREDENTIAL_ACCESS',
    mode: 'INFERRED',
    confidence: 0.7,
    kinds: '*',
    pattern:
      /\.ssh[\\/]|\bid_(?:rsa|ed25519|ecdsa)\b|\.aws[\\/]credentials|[\\/.]npmrc\b|\.netrc\b|\.docker[\\/]config\.json|\.kube[\\/]config|\.git-credentials|\.gnupg\b|\bwallet\.dat\b/i,
  },
  {
    id: 'any.browser-data',
    capability: 'BROWSER_DATA_ACCESS',
    mode: 'INFERRED',
    confidence: 0.7,
    kinds: '*',
    pattern:
      /\bLogin Data\b|\bkey4\.db\b|\blogins\.json\b|\bUser Data[\\/]Default\b|Application Support[\\/](?:Google|Firefox)|\.mozilla[\\/]firefox|\.config[\\/](?:google-chrome|chromium)/,
  },

  // ---- Persistence (any file kind) -----------------------------------------------------------
  {
    id: 'persist.systemd',
    capability: 'PERSISTENCE',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: '*',
    persistence: 'systemd_service',
    pattern:
      /\bsystemctl\s+(?:--user\s+)?(?:enable|daemon-reload)\b|\/etc\/systemd\/system|\.config\/systemd\/user|\bWantedBy\s*=/,
  },
  {
    id: 'persist.cron',
    capability: 'PERSISTENCE',
    mode: 'DIRECT',
    confidence: 0.8,
    kinds: '*',
    persistence: 'cron_job',
    pattern:
      /\bcrontab\s+(?:-|\w)|\/etc\/cron(?:\.d|\.daily|tab)\b|\/var\/spool\/cron|(?:^|\s)@reboot\s/,
  },
  {
    id: 'persist.launchd',
    capability: 'PERSISTENCE',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: '*',
    persistence: 'launchd_service',
    pattern: /\bLaunchAgents\b|\bLaunchDaemons\b|\blaunchctl\s+(?:load|bootstrap|submit)\b/,
  },
  {
    id: 'persist.registry-run',
    capability: 'PERSISTENCE',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: '*',
    persistence: 'registry_run_key',
    pattern: /CurrentVersion[\\/]+Run(?:Once)?\b/i,
  },
  {
    id: 'persist.schtasks',
    capability: 'PERSISTENCE',
    mode: 'DIRECT',
    confidence: 0.85,
    kinds: '*',
    persistence: 'scheduled_task',
    pattern: /\bschtasks(?:\.exe)?\s+\/create\b|\bRegister-ScheduledTask\b|\bNew-ScheduledTask\b/i,
  },
  {
    id: 'persist.windows-service',
    capability: 'PERSISTENCE',
    mode: 'DIRECT',
    confidence: 0.8,
    kinds: '*',
    persistence: 'windows_service',
    pattern: /\bsc(?:\.exe)?\s+create\b|\bNew-Service\b|\bnssm\s+install\b/i,
  },
  {
    id: 'persist.startup-folder',
    capability: 'PERSISTENCE',
    mode: 'DIRECT',
    confidence: 0.75,
    kinds: '*',
    persistence: 'startup_folder',
    pattern:
      /Start Menu[\\/]+Programs[\\/]+Startup|\.config\/autostart|\/etc\/xdg\/autostart|\/etc\/rc\.local|\/etc\/init\.d\//,
  },
  {
    id: 'persist.shell-profile',
    capability: 'PERSISTENCE',
    mode: 'INFERRED',
    confidence: 0.7,
    kinds: '*',
    persistence: 'shell_profile_modification',
    pattern:
      /(?:>>|\btee\s+-a)\s*["']?(?:~|\$HOME|\$\{HOME\})?\/?\.?(?:bashrc|zshrc|bash_profile|zprofile|profile|zshenv)\b|(?:appendFile\w*|open|writeFile\w*)\s*\([^)]{0,120}\.(?:bashrc|zshrc|bash_profile|zprofile)\b/,
  },
  {
    id: 'persist.login-item',
    capability: 'PERSISTENCE',
    mode: 'INFERRED',
    confidence: 0.7,
    kinds: '*',
    persistence: 'login_item',
    pattern: /\bSMLoginItem\w*|\bLSSharedFileList\w*|login item/i,
  },
  {
    id: 'persist.browser-extension',
    capability: 'PERSISTENCE',
    mode: 'INFERRED',
    confidence: 0.6,
    kinds: '*',
    persistence: 'browser_extension_install',
    pattern: /--load-extension\b|\bExtensionInstallForcelist\b|\bchrome\.management\.install/,
  },
  {
    id: 'persist.ssh-keys',
    capability: 'PERSISTENCE',
    mode: 'INFERRED',
    confidence: 0.65,
    kinds: '*',
    persistence: 'ssh_authorized_keys_write',
    pattern: /\bauthorized_keys\b/,
  },
  {
    id: 'persist.restart-policy',
    capability: 'PERSISTENCE',
    mode: 'INFERRED',
    confidence: 0.5,
    kinds: ['yaml', 'sh', 'make', 'docker'],
    persistence: 'container_restart_policy',
    pattern:
      /\brestart\s*:\s*['"]?(?:always|unless-stopped)\b|--restart[= ](?:always|unless-stopped)\b/,
  },
];

const COMMENT = {
  js: /^\s*(?:\/\/|\*|\/\*)/,
  go: /^\s*(?:\/\/|\*|\/\*)/,
  rs: /^\s*(?:\/\/|\*|\/\*)/,
  py: /^\s*#/,
  sh: /^\s*(?:#(?!!)|REM\b|::)/i,
  make: /^\s*#/,
  docker: /^\s*#/,
  yaml: /^\s*#/,
  other: /^\s*#/,
} satisfies Record<FileKind, RegExp>;

export const isCommentLine = (kind: FileKind, line: string): boolean => COMMENT[kind].test(line);

/** Compound-chain building blocks (see scan.ts). */
export const PIPE_TO_SHELL =
  /(?:curl|wget|iwr|Invoke-WebRequest)[^|\n]{0,400}\|\s*(?:sudo\s+(?:-E\s+)?)?(?:ba|z|da|k)?sh\b|\|\s*(?:iex|Invoke-Expression)\b|\beval\s+["']?\$\([^)]{0,300}(?:curl|wget)|\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)/i;
export const EXTRACT =
  /\b(?:tar\s+-?[a-z]*x[a-z]*|unzip|7z\s+x|extractall|extract-zip|Expand-Archive)\b/i;
export const EXEC_FETCHED =
  /(?:^|[\s;&|(])(?:\.\/[\w./-]{1,100}|(?:ba|z)?sh\s+[\w./-]{1,100}|start\s+[\w./-]{1,100}\.exe)\b|\b(?:os\.system|subprocess\.\w+|exec\.Command|child_process|execSync|spawnSync|Command::new)\b/;
