add_library(shapes_alias ALIAS shapes)
add_executable(shapes_test test_shapes.cc)
target_link_libraries(shapes_test PRIVATE shapes_alias GTest::gtest_main)
add_test(NAME shapes_test COMMAND shapes_test)

add_executable(test_runner runner.cc)
add_test(runner_check test_runner)

add_executable(tool tool.cc)
