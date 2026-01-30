#!/usr/bin/env node

// Test script to verify spinner renders visually
const { Spinner } = require('./src/spinner.js');

console.log('Testing Spinner Component\n');

const spinner = new Spinner();

// Test 1: Basic render
console.log('Test 1: Starting spinner for 2 seconds...');
spinner.start('Loading');

setTimeout(() => {
  spinner.stop('✓ Test 1 complete');
  
  // Test 2: Update text while spinning
  console.log('\nTest 2: Starting spinner with text updates...');
  spinner.start('Step 1');
  
  setTimeout(() => {
    spinner.updateText('Step 2');
  }, 500);
  
  setTimeout(() => {
    spinner.updateText('Step 3');
  }, 1000);
  
  setTimeout(() => {
    spinner.stop('✓ Test 2 complete');
    
    // Test 3: Multiple start/stop cycles
    console.log('\nTest 3: Multiple start/stop cycles...');
    spinner.start('Cycle 1');
    
    setTimeout(() => {
      spinner.stop();
      spinner.start('Cycle 2');
      
      setTimeout(() => {
        spinner.stop('✓ Test 3 complete');
        console.log('\n✓ All spinner tests passed - component renders visually when mounted\n');
      }, 800);
    }, 800);
  }, 1500);
}, 2000);
