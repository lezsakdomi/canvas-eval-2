# canvas-eval-2
Automatic Canvas LMS task evaluator

Made for ease lecturing programming courses

## Usage

1. Give students an assignment, for which they can submit files!
2. Create machine-readable rubric descriptions! One assignment can have multiple rubrics, for which they either get the maximum point assigned or not.
3. Edit `test.sh`! It will receive the rubric description as input, and the user submission as file in the current working directory.
4. Submit a test-solution using your class' test user!
5. Find out your test user ID! You can copy it from URL
6. Run the script to grade the test user only: `deno run --allow-net --allow-run ./app.ts --test`
7. Check if everything went fine
8. Publish the assignment
9. Run `deno run --allow-net --allow-run ./app.ts` periodically. It will grade every new submission.

Note that you can avoid using environment variables, by specifying the respective arguments instead. See `deno run ./app.ts --help`.
