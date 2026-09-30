process.stderr.write('fixture stderr\n');
process.stdin.pipe(process.stdout);
process.stdin.on('end', () => { process.exitCode = 23; });
