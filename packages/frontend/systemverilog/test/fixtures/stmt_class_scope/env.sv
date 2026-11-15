class my_env;
  int x;
  function void set();
  endfunction
  function void build();
    uvm_config_db#(int)::set(null, "*", "x", 1);
    x = A#(int)::m();
    x = B::m();
  endfunction
endclass
