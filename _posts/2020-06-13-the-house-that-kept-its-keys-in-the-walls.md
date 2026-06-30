---
layout: post
title: "The House That Kept Its Keys in the Walls"
subtitle: "HTB Nest, where every secret is a breadcrumb to the next, and the box never once hands you a memory-corruption bug — just a long hallway of doors that were never really locked"
date: 2020-06-13 12:00:00 +0000
description: "A medium Windows box with no exploit at all — just a chain of secrets, each one decrypted to find the address of the next, all the way down to a binary you have to read."
image: /assets/og/the-house-that-kept-its-keys-in-the-walls.png
tags: [hackthebox, writeup]
---

Nest is a house with no broken windows. Nobody pries a lock, nobody throws a brick, nobody finds a single overflow or injection in the whole place. Instead you walk a long hallway, and every door has a key taped to the back of the door before it. An anonymous share gives up a welcome email. The email's password opens a second share. A config file in that share quietly names a folder you were not supposed to find. Inside the folder is a developer's old project, and the project's source teaches you how to decrypt the password sitting right next to it. That password reaches a hidden service, the service hides its debug password in the empty space behind a file, and debug mode finally coughs up a binary you have to read like a book to pull the administrator's password out of memory. No exploit. Just patience, and a refusal to accept that any locked door is actually the end of the hall.

```
        N E S T   ( H Q K )
        ===================
        anon smb  →  "welcome email"  →  TempUser:welcome2019
              |
        Secure$   →  notepad++ config remembers a path
              |       you were never shown
              v
        Carl's old VB project teaches you its own crypto.
        decrypt the password lying next to it → c.smith
              |
        :4386  HQK service. debug pw hidden BEHIND a 0-byte file.
              |
              v
        read the binary. watch it decrypt the admin in memory.
        every key was taped to the wall the whole time.
                                            鍵
```

## 0x01 · the unlocked foyer

The port scan is almost insultingly quiet for a Windows box. SMB on 445, and one stranger up high.

```
PORT     STATE SERVICE       VERSION
445/tcp  open  microsoft-ds
4386/tcp open  unknown       HQK Reporting Service V1.2
```

That 4386 is the whole point of the box wearing a name tag, but it does not let you in yet. Start where Windows always leaks first, the file shares. Anonymous, no password.

```
$ smbmap -H 10.10.10.178 -u null
        Disk           Permissions
        ----           -----------
        Data           READ ONLY
        Users          READ ONLY
        Secure$        NO ACCESS
        IPC$           NO ACCESS
```

`Secure$` says no, which is a promise that it has something. `Data` says yes, which means it has something the owner forgot about. We take the door that opens.

## 0x02 · a welcome email nobody revoked

Dig through `Data` with `smbclient -N //10.10.10.178/data` and the useful artifact is a new-hire onboarding note sitting in a Shared folder.

```
smb: \Shared\Templates\HR\> get "Welcome Email.txt"

   We are excited to have you on board ...
   Username: TempUser
   Password: welcome2019
```

A temp account with the year baked into the password, left in a world-readable share. Picture the spare key under the mat, except the mat also has a laminated card explaining which door it fits. `TempUser:welcome2019` is not admin, not even close. It is just the next key down the hall.

## 0x03 · the config that remembered too much

Logged in as `TempUser`, `Secure$` finally opens, but most of it stays dark. You can list folders and get told no the instant you try to enter them. The trick is that one application on this box keeps a memory of where it has been, and it does not respect the access controls. Notepad++ writes a recent-files list.

```
smb: \> get IT\Configs\NotepadPlusPlus\config.xml
```

Inside that XML is a history entry pointing at `\\HTB-NEST\Secure$\IT\Carl\Temp.txt`. You cannot list `IT\Carl` from the outside, but you do not need to list it. You were handed the exact path. Think of it like a building where the front desk won't tell you who lives on the fourth floor, but a delivery slip on the floor reads apartment 4B by name. The directory's secrecy was a curtain, not a wall, and the config peeked behind it for you.

Walk straight to `IT\Carl\VB Projects\WIP\RU\` and pull the whole RUScanner project down. A developer left their working source on a file share, which is its own quiet tragedy.

## 0x04 · the project that taught you its own lock

The project ships two gifts. A config file with a secret, and the source code that made the secret.

```
RU_Config.xml:
   <Password>fTEzAfYDoz1YzkqhQkH6GQFYKp1XY5hm7bjOP86yYxE=</Password>
   <Username>c.smith</Username>
```

That blob is `c.smith`'s password, encrypted. On its own it is gibberish. But the same folder holds `Utils.vb`, and the decryption routine is right there in plain VB.NET, every parameter spelled out like a recipe card.

```
Crypto.Algorithm   AES-CBC (256-bit)
Crypto.Passphrase  "N3st22"
Crypto.Salt        "88552299"
Crypto.IV          "464R5DFA5DL6LE28"
Crypto.PBKDF2 iter 2
```

This is the cleanest reversing lesson the box offers. You do not have to guess the cipher, the key derivation, the salt, or the IV. The author handed you all of it because the program needs all of it to run. Custom crypto in a shipped binary is never really secret. The machine has to be able to undo it, which means the instructions for undoing it are sitting in the machine. Picture a diary written in a code, then realize the decoder ring is glued to the inside of the back cover. You are not breaking the code. You are reading the manual that came with it.

Compile the project as-is with a `Console.WriteLine` dropped after the decrypt call, or paste the decrypt function into a throwaway .NET fiddle. Either way the password falls out.

```
$ ./RUScanner.exe
c.smith : xRxRxPANCAK3SxRxRx
```

`xRxRxPANCAK3SxRxRx` is a real Windows credential. Use it for the next door.

## 0x05 · the service and the room behind the file

Now port 4386 finally matters. It speaks a tiny custom protocol, and there is a gotcha that eats an hour if you let it: `telnet` works and `nc` appears to hang, because the HQK service wants Windows line endings. It is waiting for a carriage return and a newline, and raw netcat only sends the newline. The service is not down. It is politely waiting for you to finish your sentence the way Windows finishes sentences.

```
$ telnet 10.10.10.178 4386
HQK Reporting Service V1.2
>help
LIST
SETDIR <Directory_Name>
RUNQUERY <Query_ID>
DEBUG <Password>
```

`DEBUG` wants a password you do not have. And here the box plays its prettiest trick. Back in `c.smith`'s share there is a file called `Debug Mode Password.txt` that is zero bytes long. Empty. A dead end, unless you know that NTFS lets a file carry hidden content in a parallel stream attached to the same name, an alternate data stream. The visible file is empty. The room behind it is not.

```
smb: \> allinfo "Debug Mode Password.txt"
        stream: [:Password:$DATA], 15 bytes
smb: \> get "Debug Mode Password.txt:Password"
```

Think of it like a manila envelope that reads empty when you hold it to the light, but has a second pocket sewn into the lining. `allinfo` is the X-ray that shows the seam. The stream holds `WBQ201953D8w`. Feed it to `DEBUG` and the service unlocks a fistful of new commands, including ones that read files off disk and let you wander the HQK install directory.

## 0x06 · reading the binary to find the boss

Debug mode lets you browse `C:\Program Files\HQK\`, and the prize is `LDAP\HqkLdap.exe` alongside a `Ldap.conf`. The config is the same shape as before, an encrypted password belonging to `Administrator`.

```
Ldap.conf:
   Domain   = nest.local
   User     = Administrator
   Password = yyEq0Uvvhq2uQOcWG8peLoeRQehqip/fKdeG/kjEVb4=
```

This time the crypto is not handed to you in friendly source. It is compiled into `HqkLdap.exe`, a small .NET console binary. So you read the binary the way you read decompiled code, by opening it in a .NET disassembler. dnSpy turns the executable back into something close to its original C#, and the config parser shows its hand.

```
ldapSearchSettings.Password = CR.DS(text.Substring(text.IndexOf('=') + 1));
```

`CR.DS()` is the decrypt routine. It is a cousin of the RUScanner crypto, but with its own keys, and rather than reconstruct every constant by hand you let the program do the work for you. Set a breakpoint immediately after the `CR.DS()` call, run the binary under the debugger pointed at the captured config, and when execution pauses, the plaintext password is just sitting there in a local variable. Picture a safe whose combination you cannot read, so instead of cracking it you wait by the safe and watch the manager spin it open, then read the number over their shoulder. The binary decrypts its own secret. You only have to be present at the moment it does.

```
[breakpoint hit @ HqkLdap.Program]
   ldapSearchSettings.Password = "XtH4nkS4Pl4y1nGX"
```

## 0x07 · walking in the front door at last

`Administrator:XtH4nkS4Pl4y1nGX`. No token magic, no kernel exploit, no scheduled-task race. The administrator's password was the last key on the chain, and the chain started at an anonymous share. Drop it into PsExec and take a SYSTEM shell.

```
$ psexec.py administrator:XtH4nkS4Pl4y1nGX@10.10.10.178
[*] Found writable share ADMIN$
[*] Opening SVCManager on 10.10.10.178.....
C:\Windows\system32> whoami
nt authority\system
```

```
C:\> type C:\Users\C.Smith\Desktop\user.txt
████████████████████████████████
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x08 · the honest caveat

There is no CVE on Nest. That is the whole lesson, and it is a harder one to swallow than any single bug. Every step on this box is a piece of software doing precisely what it was built to do. The Notepad++ config remembered a path because remembering paths is its job. NTFS carried a hidden stream because alternate data streams are a documented, intended feature. The two custom apps decrypted their own configs because an app cannot use a secret it cannot read. PsExec ran as SYSTEM because that is what an administrator credential is for. Nothing here was unpatched. There is nothing to patch.

What there is, instead, is a long line of secrets stored as if storage were the same thing as security. A password in a world-readable share. A credential reachable through an app's history file. Reversible crypto with the keys shipped beside the ciphertext. A debug password hidden in a place that feels clever but is just a feature in the manual. Every one of those is a decision someone made to obscure a secret rather than guard it, and obscuring is not guarding. The attacker who reads carefully always undoes obscurity, because the program standing next to the secret already knows how. The only secret that survives an attacker who reaches the box is one the box itself cannot reverse, and a config file the application has to read is never that.

## 0x09 · outro

```
no window was broken here.
every key was taped to the back of the last door,
and the house could not help but read its own configs aloud.

a hidden stream is still a feature. reversible crypto is still readable.
a secret you can decrypt is a secret you only borrowed.

read the config. check the stream. watch the binary spin its own lock. wear black.

                                                            EOF
```

---

*HTB: Nest, retired 6 June 2020. A medium Windows box with not one exploit on it — just a hallway of doors, each opened by the key behind the one before, all the way down to a binary you have to read aloud to itself.*