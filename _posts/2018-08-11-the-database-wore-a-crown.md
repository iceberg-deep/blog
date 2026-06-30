---
layout: post
title: "The Database Wore a Crown"
subtitle: "HTB Silo, where an Oracle database with a default password writes a webshell into the web root as SYSTEM, and the final hash falls out of a crash dump someone left in the cloud"
date: 2018-08-11 12:00:00 +0000
description: "Silo is an Oracle database running as SYSTEM that you log into with a 1977 default password, then make it write a shell into IIS for you. Root is a password and a hash, no exploit in sight."
image: /assets/og/the-database-wore-a-crown.png
tags: [hackthebox, writeup]
---

Silo is a box about a service that was given too much power and then handed its keys to the first person who knew the password from a textbook. There is no memory corruption here, no CVE to cite, no clever race. There is an Oracle database listening on the network, you guess its name, you log in with a username and password that have been the same default since the Carter administration, and because the database runs as SYSTEM you simply ask it to write a file into the web folder for you. The file is a shell. After that the box hands you root twice, once through the privileges Oracle was already carrying, and once through a crash dump somebody parked in a Dropbox and wrote the password to on a sticky note. Nothing is forced. Everything is given away.

```
        S I L O
        =======
        1521/tcp   "what's the database called?"
                   you guess. it's XE. of course it's XE.

        login:  SCOTT / tiger      (a default since 1977)
                   |
                   v
        the database runs as SYSTEM, so you ask it nicely:
        "write this file into C:\inetpub\wwwroot for me"
                   |
                   v
        it does. the file is a shell.
        and the crown was on the database the whole time.
                                            鍵
```

## 0x01 · the listener

`nmap -sC -sV` paints a Windows server with one unusual face in the lineup.

```
PORT      STATE SERVICE       VERSION
80/tcp    open  http          Microsoft IIS httpd 8.5
135/tcp   open  msrpc         Microsoft Windows RPC
139/tcp   open  netbios-ssn
445/tcp   open  microsoft-ds
1521/tcp  open  oracle-tns    Oracle TNS Listener 11.2.0.2.0
5985/tcp  open  http          Microsoft HTTPAPI (WinRM)
47001/tcp open  http          Microsoft HTTPAPI
```

The web server is a default IIS splash page, which is a polite way of saying it has nothing for you. The interesting light on the board is 1521, an Oracle TNS listener. Most people never touch Oracle, and the box knows it, because the entire front half of Silo is just "go learn how to talk to a database you have never spoken to." The TNS listener is the receptionist for an Oracle install. It will not tell you anything useful until you can name the specific database instance you want, and that name is a secret called the SID.

## 0x02 · guessing the database's name

You cannot connect to an Oracle instance without its SID, the System Identifier, a short label that names which database behind the listener you mean. Think of the listener as the front desk of a big office building and the SID as the name of the exact company on the directory. The desk will not connect your call until you say a name that is actually on the board. So you read the board out loud, fast, until something answers.

The tool for all of this is `odat`, the Oracle Database Attacking Tool. Its `sidguesser` module throws a wordlist of common instance names at the listener and watches for the one that does not bounce.

```
$ odat sidguesser -s 10.10.10.82 -p 1521
[+] Searching valid SIDs
[+] 'XE' is a valid SID. Continuing...
[+] 'XEXDB' is a valid SID.
```

`XE` is Oracle Express Edition's default instance name, the one you get if you click Next, Next, Finish and never think about it again. The fact that it answers tells you a lot about how this database was installed, which is to say, not carefully.

## 0x03 · the password from 1977

Now you need an account. Oracle ships with a museum of demo accounts, and the most famous of them is `SCOTT`, a sample user named after a Bruce Scott who worked on the original Oracle in the late seventies. His password in the demo data was `tiger`, the name of his daughter's cat. That pair, `SCOTT/tiger`, has been the canonical "did anyone lock this down" credential for over forty years, and it is still sitting here, unlocked.

The catch, and the part of Silo people actually get stuck on, is that `odat`'s built-in password list shouts everything in capital letters, and Oracle treats `TIGER` and `tiger` as different passwords. Picture a lock that cares whether you whisper or shout the same word. Yell the right answer in the wrong tone and the door stays shut. So you feed the guesser a lowercase list, or script the connection check yourself, and the lock finally turns.

```
$ odat passwordguesser -s 10.10.10.82 -d XE --accounts-file lowercase.txt
[+] Valid credentials found: SCOTT/tiger

$ sqlplus SCOTT/tiger@10.10.10.82:1521/XE
SQL> select user from dual;
USER
------------------------------
SCOTT
```

You are in the database. A normal database account is a tenant with a small apartment. But this one has a master key, because of what the database itself is running as.

## 0x04 · the crown nobody took off

Here is the hinge of the whole box. On Windows, the Oracle service runs as `NT AUTHORITY\SYSTEM`, the highest local account there is. Every file the database touches, it touches as SYSTEM. So when you, a lowly `SCOTT`, ask the database to write a file somewhere, the database does it wearing the crown.

Think of it like asking a clerk to drop a letter in a locked mailroom. You are not allowed in that room. But the clerk has the master key for the whole building, and he does not check whether your letter belongs there. He just carries it in because you asked. The file you ask Oracle to carry is a webshell, and the room you ask it to drop the file into is the IIS web root, `C:\inetpub\wwwroot`, which the web server will happily run for anyone who visits.

`odat` has a file-write module. With `--sysdba` to claim full database authority, you have it carry your shell into the web folder.

```
$ odat dbmsadvisor -s 10.10.10.82 -d XE -U SCOTT -P tiger --sysdba \
    --putFile C:\\inetpub\\wwwroot iceberg.aspx ./iceberg.aspx
[+] Sending iceberg.aspx to the server...
[+] The iceberg.aspx file was created on the C:\inetpub\wwwroot directory
```

The shell itself is an ASPX command-runner, and I am describing it rather than printing it, on purpose. A literal webshell on disk is exactly the kind of string an antivirus quarantines on sight, and shipping a copy-paste backdoor is not what we do here.

```
iceberg.aspx  →  [ an ASPX webshell: runs the 'cmd' request parameter and prints the output ]
```

Browse to it, pass a command, and the web server answers as the account it runs under.

```
http://10.10.10.82/iceberg.aspx?cmd=whoami
iis apppool\defaultapppool
```

That is a foothold. From here you trade the webshell up for a real shell. Drop a small payload, point a listener at yourself, and catch it.

```
http://10.10.10.82/iceberg.aspx?cmd=[ download + run a reverse shell back to 10.10.14.4:443 ]

$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.82
PS C:\windows\system32\inetsrv> whoami
iis apppool\defaultapppool
```

## 0x05 · root the loud way, root the elegant way

The app-pool identity is low, but remember who actually wrote your file. Oracle is SYSTEM, and a SYSTEM-level database is a hand you can pull twice.

The blunt route is to skip the web folder entirely. Instead of writing a shell, have `odat` write a payload straight onto the Administrator's Desktop and run it, all as SYSTEM, because that is who Oracle is. The Oracle process is already holding the `SeImpersonate` privilege that service accounts get, which is the same lever that the Potato family of exploits (`RottenPotato`, `JuicyPotato`, the `ms16_075_reflection_juicy` variant) uses to trade a service token for a SYSTEM token. On Silo you barely need it, because Oracle is not a service you have to escalate from, it is SYSTEM already. Ask the database to run your code and the code runs as the crown.

But the elegant route, the one the box is actually teaching, is sitting in plain sight in a file on Phineas's desktop.

```
PS> type "C:\Users\Phineas\Desktop\Oracle issue.txt"
[ a note describing a database crash, a Dropbox link, and a password ]
```

The note is a support ticket. Someone hit a database problem, took a full memory dump of the machine, and uploaded it to a Dropbox folder so a vendor could look. They helpfully wrote the share password right there in the file. A quick gotcha worth flagging, the password contains a character that renders one way when you `type` the file and another way when you read it through the webshell's encoding, so pull it through the path that shows it true.

A memory dump is a photograph of everything the machine was holding in RAM at the instant it was taken, and "everything" includes the hashed passwords of every account that was logged in. The tool that develops that photograph is Volatility. You give it the dump and the right profile, and ask it for the password hashes.

```
$ volatility -f SILO-20180105-221806.dmp imageinfo
    Suggested Profile(s) : Win2012R2x64

$ volatility -f SILO-20180105-221806.dmp --profile Win2012R2x64 hashdump
Administrator:500:aad3b435b51404eeaad3b435b51404ee:9e730375b7cbcebf74ae46481e07b0c7:::
```

That trailing block is the Administrator's NTLM hash. And on Windows you do not always need to crack a hash back into a password, because for a lot of authentication the hash *is* the password. The protocol proves you know the secret by doing math on the hash, never on the plaintext, so possessing the hash is possessing the account. This is pass-the-hash, and it is less a hack than a design consequence. Picture a club that checks your membership by matching a wax seal instead of your face. Steal a perfect copy of the seal and you do not need to be the member. The door cannot tell.

Impacket's `psexec` takes the hash directly and hands you a shell as Administrator.

```
$ psexec.py -hashes aad3b435b51404eeaad3b435b51404ee:9e730375b7cbcebf74ae46481e07b0c7 \
    administrator@10.10.10.82
[*] Found writable share ADMIN$
[*] Opening SVCManager on 10.10.10.82.....
C:\Windows\system32> whoami
nt authority\system
```

Two flags, two doors, neither one forced.

```
PS C:\Users\Phineas\Desktop> type user.txt
████████████████████████████████
C:\Windows\system32> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

It is easy to read Silo as a relic, an old Oracle install with a 1977 password, the kind of thing nobody runs today. The specific credential is a fossil. The shape of the mistake is not, and that is the part to keep.

Two things went wrong here, and both of them ship green, with no missing patch anywhere. The first is a powerful service running as the most privileged account on the box. Databases, print spoolers, agents, backup tools, they get installed as SYSTEM because it is easy and it always works, and every one of them becomes a way for a low user to act as the whole machine the moment one default credential survives. Oracle did not get exploited on Silo. It did exactly what a database is supposed to do, write a file where it was told, except it was wearing a crown nobody remembered to take off. The fix is not a patch. It is running services as the smallest account that can do the job, so that owning the service does not mean owning the host.

The second is the crash dump, and it is the one I would actually lose sleep over. Nothing was vulnerable about that file. It was a perfectly normal diagnostic, the kind support engineers ask for every day. But a full memory dump is a photograph of every secret the machine was holding, and the moment it leaves the building, every one of those secrets has left with it. The password was even written down next to the link. You cannot patch that. You can only treat a memory dump like the bundle of live credentials it actually is, and never let it walk out the door in cleartext. The exploit was a habit, and habits do not show up in a scan.

## 0x07 · outro

```
you guessed the database's name and it answered.
you knew a password from before you were born and it let you in.
then you asked it to carry a file, and it did, because it had the master key.

the dump was just diagnostics. the password was right there in the note.
nothing here was broken. everything here was simply handed over.

name the listener. drop the crown. read the dump before they do. wear black.

                                                            EOF
```

---

*HTB: Silo, retired 04 Aug 2018. A medium Windows box that is really a lesson in a service with too much power and a default password that outlived the people who set it. The database had the crown the whole time.*