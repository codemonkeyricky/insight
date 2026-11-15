add_library(shapes STATIC src/shapes.cc include/shapes/area.h)
target_include_directories(shapes PUBLIC include)
target_link_libraries(shapes PRIVATE fmt::fmt rt)
