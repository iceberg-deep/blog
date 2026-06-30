---
layout: post
title: "The Question That Could Not Say No"
subtitle: "HTB Mango, where a login form that asks 'is the password equal to this' gets tricked into asking 'is it not equal to anything,' and a SUID Java toy reads the crown jewels"
date: 2020-04-25 12:00:00 +0000
description: "A NoSQL login form gets asked the wrong question, leaks both passwords one letter at a time, and a forgotten SUID Java shell hands over root."
image: /assets/og/the-question-that-could-not-say-no.png
tags: [hackthebox, writeup]
---

Mango is a box about asking the wrong question and getting an honest answer anyway. There is a login form here, and behind it sits a database that does not speak SQL. It speaks documents, and it takes the username and password you type and folds them straight into a query object without thinking twice about their shape. So instead of handing it a password, you hand it a clause. You stop saying "the password is this word" and start saying "the password is not equal to nothing," which is true for everybody, and the door swings open. Then you turn the same trick into a slow drip, asking the database one letter at a time whether the real password starts with an a, a b, a c, until both accounts bleed their secrets onto the floor. The climb to root is almost gentle by comparison. A reused password, a friendly su, and a little Java toy left wearing root's badge.

```
        M A N G O
        =========
        login:  password == "hunter2" ?   no.
        login:  password != nothing   ?   ...yes?
                        |
                        v
        the database answers honestly. it was
        never asked who you are, only whether
        a clause is true. it is.

        then, one letter at a time:
        "does the real password start with t?"  yes.
        "...with t9?"  yes.  "...t9K?"  yes.
                        |
                        v
        a SUID java shell reads /root by hand.
                                            問
```

## 0x01 · two names on one door

`nmap -sC -sV` is short and tidy. SSH, HTTP, and HTTPS, nothing exotic.

```
PORT    STATE SERVICE  VERSION
22/tcp  open  ssh      OpenSSH 7.6p1 Ubuntu 4ubuntu0.3
80/tcp  open  http     Apache httpd 2.4.29 ((Ubuntu))
443/tcp open  ssl/http Apache httpd 2.4.29 ((Ubuntu))
```

Port 80 throws a 403 in your face, a locked front door with nothing to see. Port 443 serves a knockoff search page, a Google impersonator with most of its buttons painted on. The real tell is hiding in the TLS certificate. Read the cert details and a second hostname falls out, `staging-order.mango.htb`. A certificate is just an ID card the server hands you to prove who it is, and like a lot of ID cards it says more than the bearer meant it to. The name on the card was never supposed to be a map, but it is one. Drop `mango.htb` and `staging-order.mango.htb` into your hosts file, browse to the staging host, and the 403 melts into a real login form. The front door was locked. The staging door, the one the certificate quietly named, was not.

## 0x02 · the form that took a clause instead of a word

The login form POSTs a username and a password, the most ordinary thing on the internet. The question is what catches them on the far side. This box runs MongoDB, a database that stores documents instead of rows and queries them with little objects full of operators. The danger is that PHP, when it reads form fields shaped like `username[$ne]=x`, does not hand the backend a string. It hands it a nested array. And if that array slides straight into a Mongo query, the operator inside it is now part of the question being asked.

Picture a bouncer with a clipboard who is told to check whether your name equals a name on the list. Normally you say "Dave," and he checks for Dave. But this bouncer reads whatever you write in the name box and copies it into his instructions literally. So you write "not equal to nobody." Now his instruction reads "let them in if their name is not equal to nobody," which is true for every human alive, and he waves you through without ever learning who you are.

That is the `$ne` operator, "not equals," and the bypass is exactly that sentence.

```
# the POST body that walks past the login
username[$ne]=iceberg&password[$ne]=iceberg&login=login
```

You are not guessing a password. You are changing the verb of the question from "equals" to "not equals," and the database, asked an honest question, gives an honest answer. The page that comes back is the logged-in view, a cheerful little "We just started farming!" that means you are inside.

## 0x03 · the password, one letter at a time

A bypass is a thrill that gets you nowhere durable. You are in as "somebody," but you have no actual credentials, and the box wants SSH. So you make the same form confess. Mongo has a `$regex` operator, a pattern match, and a pattern is a yes-or-no question you can aim with surgical precision. Ask "does the password match the pattern that starts with the letter t," and the page either shows the farming message or it does not. Yes or no. One bit.

Think of it like the cold-or-warm game with a kid hiding a number. You cannot see the password, but you can ask "does it begin with a?" and read the answer off the kid's face. No. "Does it begin with b?" No. Walk the alphabet until you get a yes, lock that letter in, and start over on the next position. Slow, but it never misses, because the database cannot help telling you the truth.

```
# pin admin and walk the regex one character at a time
username=admin&password[$regex]=^t.*&login=login        -> "We just started farming!"
username=admin&password[$regex]=^t9.*&login=login       -> hit
username=admin&password[$regex]=^t9K.*&login=login       -> hit
```

A short script does the walking. It loops the printable characters, escapes the regex-special ones that would poison the pattern (`. * + ? | \ $ ^` and friends), appends each candidate, and keeps whichever extends the known prefix. Repeat it once per user. Two accounts give up their passwords:

```
admin : t9KcS3>!0B#2
mango : h3mXK8RhU~f{]f5H
```

The login form was built to verify one password at a time. By asking it a thousand tiny questions instead of one, you turn a yes/no gate into a printer that spells the answer out loud.

## 0x04 · the name that was allowed in

Two passwords, but the box is choosy about who may SSH. The server's `sshd_config` carries an `AllowUsers mango root`, a guest list with exactly two names on it, and `admin` is not one of them. So the admin password, freshly bled out of the database, cannot open the SSH door directly. The `mango` password can.

```
$ sshpass -p 'h3mXK8RhU~f{]f5H' ssh mango@10.10.10.162
mango@mango:~$ id
uid=1000(mango) gid=1000(mango) groups=1000(mango)
```

Now you are `mango`, and the second password is still in your pocket. People reuse passwords across accounts the way they reuse a house key for the shed, and here the database password for `admin` is also the Unix password for `admin`. A plain `su` walks you sideways into the account that actually holds the user flag.

```
mango@mango:~$ su - admin
Password: t9KcS3>!0B#2
admin@mango:~$ cat user.txt
████████████████████████████████
```

## 0x05 · the toy that wore root's badge

`admin` is not root, so you go looking for something owned by root that `admin` is still allowed to run. The classic hunt is `find / -perm -4000 2>/dev/null`, listing every SUID binary, every program that runs with its owner's power instead of yours. One result does not belong.

```
admin@mango:~$ find / -perm -4000 2>/dev/null | grep jvm
/usr/lib/jvm/java-11-openjdk-amd64/bin/jjs
```

`jjs` is the JavaScript engine that shipped inside old Java, a little scratchpad for running JavaScript on top of the Java runtime. Here it is SUID and owned by root, which means any code it runs, runs as root. And because it is a full Java engine, "any code" includes opening files and writing files with the whole standard library at your back. Picture an intern handed the boss's keycard "just to test the door." The intern only wanted to run a tiny script, but the keycard does not check intentions. It opens every room the boss can enter.

You do not even need a shell to win. Java can read a file straight off disk, so you ask `jjs` to read root's flag for you, line by line.

```
admin@mango:~$ echo 'var r=new java.io.BufferedReader(new java.io.FileReader("/root/root.txt")); \
  var l; while((l=r.readLine())!=null) print(l);' | jjs
████████████████████████████████
```

Reading the flag is a parlor trick. Real ownership means a shell, and the same engine that reads files can write them. Have `jjs` open root's `authorized_keys` and write your own public key into it, then SSH in as root with no password at all. (Spawning a shell directly through `Runtime.getRuntime().exec` is fussy because of how `jjs` drops privileges, so the key-write is the clean path.)

```
admin@mango:~$ echo 'var w=new java.io.FileWriter("/root/.ssh/authorized_keys"); \
  w.write("ssh-rsa AAAA...iceberg-key... iceberg"); w.close();' | jjs

$ ssh -i iceberg_key root@10.10.10.162
root@mango:~# id
uid=0(root) gid=0(root) groups=0(root)
```

The badge opened every door because nobody told it to ask why.

## 0x06 · the honest caveat

It is easy to file Mango under "NoSQL injection," tick the box, and move on. But the lesson underneath is older and meaner than the database it wears. Both halves of this box are the same confession told twice. The login form took something a stranger typed and let it change the *structure* of a question, not just its contents. That is injection, full stop, the exact disease as SQL injection and command injection, only the syntax is JSON-shaped instead of quote-shaped. The fix was never "use a different database." The fix is to make sure the thing the user typed lands in the *value* slot and can never reach the *operator* slot. Cast the input to a string before it touches the query, and "not equal to nobody" becomes a literal password nobody has, instead of a clause that rewrites the question.

The SUID `jjs` is the part that should keep an admin up at night, because nothing about it was a bug. No CVE, no missing patch, no exploit binary. Someone set a SUID bit on a general-purpose programming engine, probably to make some automation convenient, and a general-purpose programming engine running as root is just a root shell with extra steps. You cannot `apt upgrade` your way out of that. The patch for the login form is a line of code. The patch for the `jjs` bit is a human deciding that "convenient" and "owned by root" should almost never be the same sentence.

## 0x07 · outro

```
the form was asked if a password equals a word.
you asked instead if it equals nothing, and it could not say no.
then you asked it the alphabet, and it spelled the answer.

root was never broken into. a toy with root's badge
read the crown jewels out loud because no one told it not to.

string your inputs. strip the SUID bit. wear black.

                                                            EOF
```

---

*HTB: Mango, retired 18 Apr 2020. A medium Linux box that is really a lecture on injection in a NoSQL costume, capped by the oldest privesc there is, a powerful program left wearing root's badge. The regex still spells passwords in a lab and nowhere you do not own.*