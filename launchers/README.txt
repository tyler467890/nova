NOVA launchers for Windows
==========================

What this does
  NOVA is a website, so it can't start programs on your laptop by itself. These two
  files add two small "links" to Windows so NOVA's Launch buttons can open:
    - Notepad++            (link: nova-npp://open)
    - Cisco Packet Tracer  (link: nova-pt://open)
  VS Code doesn't need this: installing VS Code already registers its own vscode:// link.

  It only changes settings for your Windows user (HKEY_CURRENT_USER), so no admin
  password is needed. The programs are started with no extra information passed to
  them, so a link can only open the program, nothing else.

Set up (once)
  1. Download NOVA-launchers.reg (from NOVA's Notepad++ or Packet Tracer panel, or this folder).
  2. Double-click it. Windows asks "Are you sure you want to continue?" Click Yes, then OK.
  3. In NOVA, click Launch. Chrome or Edge asks "Open Notepad++?" (or Packet Tracer).
     Tick "Always allow tyler467890.github.io to open links of this type" and click Open.

Program locations used
  Notepad++:      C:\Program Files\Notepad++\notepad++.exe
  Packet Tracer:  C:\Packet Tracer\Cisco Packet Tracer 9.0.1\bin\PacketTracer.exe
  If you move or update either program (for example a new Packet Tracer version),
  edit the path in NOVA-launchers.reg with Notepad and double-click it again.

Remove
  Double-click NOVA-launchers-uninstall.reg and click Yes. Both links are removed.
