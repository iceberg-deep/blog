---
layout: post
title: "The Backup That Forgot to Lock the Door"
subtitle: "HTB Bastion, where a writable share hands you a whole disk, the disk hands you a login, and a password manager hands you the keys to the kingdom"
date: 2019-09-14 12:00:00 +0000
description: "A guest-readable backup share holds an entire Windows disk image, and mounting it spills the SAM, then a password manager coughs up Administrator."
image: /assets/og/the-backup-that-forgot-to-lock-the-door.png
tags: [hackthebox, writeup]
---

Bastion is a box about a backup that trusted the wrong room. Somebody set up a network share to hold disk images of a workstation, the kind of routine, sensible chore that keeps a company alive after a crash. Then they left it readable to anyone who could reach the port. A backup of a Windows machine is not a file. It is the machine, frozen and packed into a single image, every secret it ever held still inside. So you copy the disk, open it like a tin of preserves, and read the password database straight out of it. That gets you a foothold. The climb to the top is even quieter, because the user kept a connection manager full of saved passwords, and the connection manager protected those passwords with a key that ships in the source code. No exploit fired on this box. Both doors were standing open the whole time.

```
        B A S T I O N
        =============
        \\10.10.10.134\Backups   "sure, read it"
                 |
                 v
        a whole disk image, sitting in the open
        mount it  →  SAM falls out  →  a login
                 |
                 v
        the user's password vault,
        locked with a key printed in the manual.
                                            砦
```

## 0x01 · the open share

`nmap` paints a short, very Windows picture. SSH on a Windows box (which is already a small tell about its age), RPC and the SMB stack, nothing else worth a second glance.

```
PORT    STATE SERVICE      VERSION
22/tcp  open  ssh          OpenSSH for_Windows_7.9
135/tcp open  msrpc        Microsoft Windows RPC
139/tcp open  netbios-ssn  Microsoft Windows netbios-ssn
445/tcp open  microsoft-ds Windows Server 2016 Standard
```

SMB is the loud one, so knock on it. List the shares with no credentials and see what answers.

```
$ smbclient -N -L //10.10.10.134
        Sharename       Type      Comment
        Backups         Disk
        IPC$            IPC       Remote IPC

$ smbmap -H 10.10.10.134 -u guest
        Backups     READ, WRITE
```

A share literally named `Backups`, readable and writable by a nobody account. That is the whole introduction. Think of it like a self-storage facility where one unit's roll-up door is propped open with a brick and the unit is full of other people's filing cabinets. You did not pick a lock. You walked in because there was no lock.

## 0x02 · a disk in a tin

Inside the share, buried a few folders deep, is a Windows Server Backup. The folder structure is its own signpost.

```
\WindowsImageBackup\L4mpje-PC\Backup 2019-02-22 124351\
   9b9cfbc3-369e-11e9-a17c-806e6f6e6963.vhd
   9b9cfbc4-369e-11e9-a17c-806e6f6e6963.vhd
```

Those `.vhd` files are virtual hard disks, an entire computer's drive saved as one file. A backup of a running Windows box is not a folder of documents. It is the C: drive, bit for bit, and a Windows drive carries the registry, and the registry carries the password hashes for every local account. Picture a moving company that, instead of packing your boxes, just lifts the entire house onto a flatbed and drives off with it, plumbing and mail and the safe in the closet still inside. The backup did that to a workstation, and then someone parked the flatbed in a public lot.

The naive move is to copy the whole multi-gigabyte image down over SMB, which is slow and rude. The tidy move is to mount the share locally and then mount the VHD straight off it, read-only, so you are reaching into the disk without dragging it home. `guestmount` from libguestfs treats the `.vhd` as the disk it is and lays its filesystem out as a normal folder.

```
$ sudo mount -t cifs //10.10.10.134/Backups /mnt/bastion -o user=guest,password=

$ guestmount --add '/mnt/bastion/WindowsImageBackup/L4mpje-PC/Backup 2019-02-22 124351/9b9cfbc4-369e-11e9-a17c-806e6f6e6963.vhd' \
    --inspector --ro /mnt/vhd
```

The first `.vhd` is a tiny system-reserved partition and gives nothing. The second is the real C: drive, and now it sits in `/mnt/vhd` like any other directory. The house came off the flatbed and you have a front door key cut to fit.

## 0x03 · reading the SAM off a dead machine

On a live Windows box the registry hives are locked files you cannot copy, guarded by the running kernel. On a mounted backup nothing is running. The kernel that protected these files is asleep, frozen at the moment of the snapshot, and the hives are just files sitting on disk. Think of it like the difference between picking a guard's pocket while he is awake versus finding his uniform, badge and all, hanging in an unlocked locker. The three you want live in the usual place.

```
/mnt/vhd/Windows/System32/config/SAM
/mnt/vhd/Windows/System32/config/SECURITY
/mnt/vhd/Windows/System32/config/SYSTEM
```

The SAM holds the account hashes, the SYSTEM hive holds the boot key that unscrambles them, and SECURITY holds a few extra secrets. Hand all three to `secretsdump.py` from Impacket and it does the unscrambling offline, no target involved.

```
$ secretsdump.py -sam SAM -security SECURITY -system SYSTEM LOCAL
[*] Dumping local SAM hashes (uid:rid:lmhash:nthash)
Administrator:500:aad3b...:31d6cfe0d16ae931b73c59d7e0c089c0:::
L4mpje:1000:aad3b435b51404eeaad3b435b51404ee:26112010952d963c8dc4217daec986d9:::
[*] Dumping cached domain logon information
[*] DefaultPassword
(Unknown User):bureaulampje
```

Two gifts in one breath. The user `L4mpje` has a crackable NT hash, and SECURITY even leaks an autologon `DefaultPassword` in cleartext, `bureaulampje`. The Administrator hash here is the empty-password default and a dead end, which is the box telling you the easy way up is not through this account. Drop the L4mpje hash into a wordlist run or just paste it into CrackStation and the same word falls out. The autologon value and the cracked hash agree, which is a nice confirmation that the dead machine and the live one share a secret.

```
$ ssh L4mpje@10.10.10.134
l4mpje@BASTION C:\Users\L4mpje> type Desktop\user.txt
████████████████████████████████
```

## 0x04 · the vault with a key in the manual

`L4mpje` is an ordinary user with no obvious power. So look where users stash their own secrets, and on this box that is a remote-connection manager. Poke through `Program Files` and `AppData` and `mRemoteNG` shows up, a tool that saves RDP and SSH logins so you never have to retype them. Convenience and danger are the same feature here. The saved logins live in one file.

```
C:\Users\L4mpje\AppData\Roaming\mRemoteNG\confCons.xml
```

Open it and there is a connection node, plainly named for the Administrator account, with its password sitting right there as a `Password` attribute. Encrypted, yes, but encrypted is not the same as safe.

```xml
<Node Name="DC" Username="Administrator"
      Password="aEWNFV5uGcjUHF0uS17QTdT9kVqtKCPeoC0Nw5dmaPFjNQ2kt/zO5xDqE4nzWoP..."
      Hostname="..." />
```

Here is the part that matters. Older mRemoteNG stored these passwords with AES, but the key used to encrypt them was not your key. It was a fixed string, `mR3m`, baked directly into the program's own source code, the same for every install on earth. Picture a hotel that gives every guest a personal lockbox, then tells you the master combination is printed on the back of every door in the building. The lockbox is real. The lock is theater, because the key is public. Anyone who reads the manual, or the source, opens every box.

So you do not crack anything. You decrypt with the key the project published itself. A small Python helper that knows the default key derivation handles it in one shot.

```
$ python3 mremoteng_decrypt.py -s "aEWNFV5uGcjUHF0uS17QTdT9kVqtKCPeoC0Nw5dmaPFjNQ2kt/zO5xDqE4nzWoP..."
Password: thXLHM96BeKL0ER2
```

That string was never secret from anyone who looked. SSH in with it and the box is over.

```
$ ssh Administrator@10.10.10.134
administrator@BASTION C:\Users\Administrator> type Desktop\root.txt
████████████████████████████████
```

## 0x05 · the honest caveat

It is tempting to read Bastion as two niche mistakes, a misconfigured share and an old version of one specific tool, and shelve it. That misses what actually happened, because the same nerve runs through both halves. A secret is only as protected as the weakest place it is allowed to rest. The login hashes were defended perfectly on the live server and then copied, naked, into a backup that anyone could read. Defending the front door means nothing if you mail a photograph of the inside of the house to the whole street.

The mRemoteNG step is the one I would lose sleep over, because nothing about it was a bug. The tool did exactly what it was built to do. It stored a password reversibly, because it has to hand that password back to you later, and reversible storage with a shared key means the key is the only thing standing between the world and your password. A fixed key in source code is no key at all. This is the quiet difference between hashing and encrypting that trips up so many honest tools. A password you must replay (your RDP login, your saved Wi-Fi, your browser's autofill) cannot be hashed, only encrypted, and encryption is just a promise that the key stays secret. The moment that key is printable in a public repository, every vault built on it is glass. You cannot patch your way out of having trusted a shared secret. You can only stop trusting it.

## 0x06 · outro

```
the share offered a backup, and a backup is the whole machine.
the disk gave up a login because nothing was awake to guard it.
the vault gave up the crown because its key was in the manual.

three doors, none of them forced. each one was held open from inside.

lock the backup. wake nothing you mean to keep. never trust a shared key. wear black.

                                                            EOF
```

---

*HTB: Bastion, retired 07 Sep 2019. An easy Windows box that is really a lecture on where secrets are allowed to rest, wearing a backup share and a password manager as its costume. The disk still mounts in a lab and nowhere you don't own.*